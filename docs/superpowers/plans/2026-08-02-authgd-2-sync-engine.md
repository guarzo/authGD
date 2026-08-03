# authGD Plan 2/3: Sync Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The complete background sync engine: a pg-boss worker (second container, same image) running the outbox dispatcher plus the five spec jobs — membership verification, contact push, Wanderer ACL sync, Discord role sync, token health — and the carry-over purge jobs, with `sync_run` recording and ops-webhook alerting.

**Architecture:** All job logic lives in `src/jobs/*` as plain async functions taking injected dependencies (`Db`, `Config`, and per-integration clients), so every job is testable without pg-boss. Pure diff/decision logic (contacts, ACL, roles, tier, affiliation bisection) lives in `src/core/*` with table-driven unit tests. Integration clients (`src/lib/esi/client.ts`, `src/lib/wanderer/client.ts`, `src/lib/discord/rest.ts`) own HTTP, validation (fail-closed zod), and transient/permanent classification. The worker entry (`src/worker/index.ts`) wires pg-boss v10 queues, schedules, the outbox dispatcher, and a dead-letter queue that posts the ops webhook after final retry failure.

**Tech Stack:** TypeScript (strict), pg-boss ^10.3 (already a dependency), Drizzle ORM + node-postgres, zod, vitest, msw (HTTP-level client tests).

**Spec:** `docs/superpowers/specs/2026-08-02-authgd-design.md` — authoritative for all behavior ("Sync jobs", "Error handling", tier model).
**Carry-over:** `docs/superpowers/plans/2026-08-02-authgd-plan2-3-carryover.md` — binding constraints from Plan 1's reviews.

## Global Constraints

- Everything in Plan 1's Global Constraints still applies (strict TS, no `any`, DbTx-only identity mutations, audit rows for state changes, conventional commits after every green cycle, `npm test` needs the dev-compose Postgres on port 5433).
- **Every job execution records exactly one `sync_run` row** via the `runJob` wrapper (Task 2). Result policy: full success → `ok`; transient failures affecting part of the run → `partial` **and throw `JobRetryError`** so pg-boss retries (jobs are idempotent, re-running is always safe); permanent/config failures → `failed` **without throwing** (no retry loop). Unexpected exceptions → `failed` + rethrow (pg-boss retries).
- **Error classification everywhere:** reuse `classifyOAuthError` / `classifyEsiError` from `src/core/errors.ts`. Affiliation bisection happens ONLY on deterministic HTTP 400. `token_status: invalid` only on permanent OAuth errors or a malformed stored token blob. Transient failures (420/429/5xx/network) never change persisted state.
- **Never remove on unknown state:** a failed read (contacts pages, ACL) aborts that reconciliation scope before any destructive write. Membership transitions require a confirmed affiliation read of the main in the same run.
- **Tier transitions commit with their downstream job triggers in one transaction:** account row locked FOR UPDATE, re-checked, updated, audit-logged, and the `outbox` row written — all in one `db.transaction`.
- **pg-boss v10 API facts** (these shape the worker code; do not "simplify" them away):
  - Queues must be created explicitly with `boss.createQueue(name, options)` before send/work.
  - `boss.work` handlers receive an **array** of jobs.
  - There is no `onComplete`; "ops webhook after final retry failure" is implemented with a **dead-letter queue** (`ops-dead-letter`) that all job queues point at, plus an immediate webhook post for permanent-config failures.
  - Retry policy on every queue: `retryLimit: 5, retryDelay: 60, retryBackoff: true` (~5 tries over ~30 min).
  - Every `send`/`schedule` payload includes a `jobType` field so the dead-letter handler can name the failed job.
  - Duplicate on-demand triggers are coalesced with `singletonKey` on `send` — **which requires `policy: "short"` on the queue**: pg-boss enforces singletonKey uniqueness only through the `job_i1` partial index scoped to `policy = 'short'` (created-state jobs, per `COALESCE(singleton_key,'')`); on the default `standard` policy a singletonKey coalesces nothing. `short` coalesces queued bursts while still permitting one trailing run when a trigger arrives during an active reconciliation. All job queues are created `short`.
- **No new advisory locks.** Character locks own class 1 (`pg_advisory_xact_lock(1, hashint8(id))` in `src/services/accounts.ts`); the dispatcher needs none because `takeUndispatched` uses FOR UPDATE SKIP LOCKED — claim and `markDispatched` happen in the SAME transaction (contract documented in `src/services/outbox.ts`).
- **Outbox fan-out semantics:** a `{kind:"account"}` row fans out to account-scoped membership + Discord-role jobs but **global** contacts/Wanderer jobs — adding a character to one account changes the desired set pushed to every other member. Global jobs coalesce via fixed singleton keys; ~20 accounts makes this cheap. The hourly schedules remain the backstop.
- **Wanderer API contract (confirmed 2026-08-02 from wanderer source):** members are read via `GET /api/acls/{aclId}` (bearer `apiKey`) under `data.members`; each member carries exactly ONE of `eve_character_id` / `eve_corporation_id` / `eve_alliance_id` (digit-strings) plus `role` (`admin|manager|member|viewer|blocked`). `POST /api/acls/{aclId}/members` with `{ member: { eve_character_id, role: "viewer" } }` adds (name is resolved server-side — never send it); `DELETE /api/acls/{aclId}/members/{eveId}` removes, where `{eveId}` is the EVE id, NOT the member row's UUID — a 404 means "already not a member" and is treated as idempotent success. **The sync job manages ONLY character entries; corporation/alliance members are never added, removed, or observed.**
- All external clients accept an injectable `fetchImpl` (Plan 1 convention). Jobs declare client dependencies as `Pick<Client, ...>` so tests inject fakes; HTTP behavior itself is tested at the client layer with msw.
- Tests: table-driven unit tests for pure logic; integration tests against `TEST_DATABASE_URL` (dev compose Postgres) via `tests/helpers/db.ts`; msw for HTTP in client tests. `vitest` runs files serially (`fileParallelism: false`) so DB tests don't interfere.
- The worker runs with `npm run worker` (tsx). Dockerfile/second-container start command is Plan 3 scope.

---

### Task 1: Discord OAuth fail-closed validation (carry-over)

`src/lib/discord/oauth.ts` currently blind-casts token/user JSON; `user.id` feeds the unique `discord_user_id` identity column. Tighten to fail-closed zod validation, mirroring `src/lib/esi/sso.ts`. Also create the shared test-config helper used by all later tasks.

**Files:**
- Modify: `src/lib/discord/oauth.ts`
- Create: `tests/helpers/config.ts`
- Test: `tests/discord-oauth.test.ts`

**Interfaces:**
- Consumes: `Config` from `src/config.ts`.
- Produces: `exchangeDiscordCode` / `fetchDiscordUser` keep their existing signatures but throw `DiscordOAuthError` (message contains "malformed") on any response that fails validation. `class DiscordOAuthError extends Error { status?: number }`.
- Produces: `testConfig(overrides?: Partial<NodeJS.ProcessEnv>): Config` in `tests/helpers/config.ts` — a fully valid Config for tests (ops webhook `https://discord.example/webhook`, wanderer base `https://wanderer.example`, standings label `flygd`, value 5, alliance 99000001, scopes = both contact scopes). Later test tasks consume this.

- [ ] **Step 1: Write the test helper and failing test**

`tests/helpers/config.ts`:

```ts
import { loadConfig, type Config } from "@/config";

export function testConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): Config {
  return loadConfig({
    DATABASE_URL: "postgres://x/y",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    APP_BASE_URL: "https://auth.example",
    ALLIANCE_ID: "99000001",
    BOOTSTRAP_ADMIN_CHARACTER_IDS: "",
    EVE_SSO_CLIENT_ID: "client-id",
    EVE_SSO_CLIENT_SECRET: "client-secret",
    EVE_SSO_SCOPES:
      "esi-characters.read_contacts.v1 esi-characters.write_contacts.v1",
    EVE_SCOPE_SET_VERSION: "1",
    DISCORD_CLIENT_ID: "d-cid",
    DISCORD_CLIENT_SECRET: "d-sec",
    DISCORD_BOT_TOKEN: "bot-token",
    DISCORD_GUILD_ID: "9000",
    DISCORD_ROLE_ID_FLYGD: "10",
    DISCORD_ROLE_ID_BLUE: "11",
    DISCORD_ROLE_ID_GREEN: "12",
    DISCORD_OPS_WEBHOOK_URL: "https://discord.example/webhook",
    WANDERER_BASE_URL: "https://wanderer.example",
    WANDERER_API_KEY: "wkey",
    WANDERER_MAP_SLUG: "map",
    WANDERER_ACL_ID: "acl-1",
    STANDINGS_LABEL: "flygd",
    STANDINGS_VALUE: "5",
    ...overrides,
  } as NodeJS.ProcessEnv);
}
```

`tests/discord-oauth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { exchangeDiscordCode, fetchDiscordUser } from "@/lib/discord/oauth";
import { testConfig } from "./helpers/config";

const cfg = testConfig();

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("exchangeDiscordCode", () => {
  it("returns the access token", async () => {
    const fetchImpl = (async () => jsonResponse({ access_token: "tok" })) as typeof fetch;
    expect(await exchangeDiscordCode(cfg, "c", "v", fetchImpl)).toEqual({
      accessToken: "tok",
    });
  });

  it("fails closed on a malformed token response", async () => {
    const fetchImpl = (async () => jsonResponse({ nope: true })) as typeof fetch;
    await expect(exchangeDiscordCode(cfg, "c", "v", fetchImpl)).rejects.toThrow(/malformed/);
  });

  it("fails closed on an empty access_token", async () => {
    const fetchImpl = (async () => jsonResponse({ access_token: "" })) as typeof fetch;
    await expect(exchangeDiscordCode(cfg, "c", "v", fetchImpl)).rejects.toThrow(/malformed/);
  });
});

describe("fetchDiscordUser", () => {
  it("returns id and username", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ id: "123456789", username: "pilot" })) as typeof fetch;
    expect(await fetchDiscordUser("at", fetchImpl)).toEqual({
      id: "123456789",
      username: "pilot",
    });
  });

  it("rejects a non-snowflake id (feeds a unique identity column)", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ id: "abc", username: "pilot" })) as typeof fetch;
    await expect(fetchDiscordUser("at", fetchImpl)).rejects.toThrow(/malformed/);
  });

  it("rejects a non-JSON body", async () => {
    const fetchImpl = (async () =>
      new Response("<html>oops</html>", { status: 200 })) as typeof fetch;
    await expect(fetchDiscordUser("at", fetchImpl)).rejects.toThrow(/malformed/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/discord-oauth.test.ts`
Expected: FAIL (`/malformed/` cases — current code blind-casts).

- [ ] **Step 3: Implement fail-closed validation**

Replace the JSON handling in `src/lib/discord/oauth.ts` (keep `buildDiscordAuthorizeUrl` unchanged):

```ts
import { z } from "zod";
import type { Config } from "@/config";

export class DiscordOAuthError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

const tokenResponseSchema = z.object({ access_token: z.string().min(1) });
// Snowflake ids are decimal digit strings; this value feeds the unique
// discord_user_id identity column, so anything else is rejected outright.
const userResponseSchema = z.object({
  id: z.string().regex(/^\d+$/),
  username: z.string().min(1),
});

export function buildDiscordAuthorizeUrl(
  cfg: Config,
  state: string,
  codeChallenge: string,
): string {
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", cfg.discord.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", `${cfg.appBaseUrl}/auth/discord/callback`);
  url.searchParams.set("scope", "identify");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeDiscordCode(
  cfg: Config,
  code: string,
  codeVerifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ accessToken: string }> {
  const res = await fetchImpl("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.discord.clientId,
      client_secret: cfg.discord.clientSecret,
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      redirect_uri: `${cfg.appBaseUrl}/auth/discord/callback`,
    }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new DiscordOAuthError(`discord token exchange failed (${res.status})`, res.status);
  }
  const parsed = tokenResponseSchema.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) throw new DiscordOAuthError("discord token response malformed");
  return { accessToken: parsed.data.access_token };
}

export async function fetchDiscordUser(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; username: string }> {
  const res = await fetchImpl("https://discord.com/api/users/@me", {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new DiscordOAuthError(`discord user fetch failed (${res.status})`, res.status);
  }
  const parsed = userResponseSchema.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) throw new DiscordOAuthError("discord user response malformed");
  return { id: parsed.data.id, username: parsed.data.username };
}
```

- [ ] **Step 4: Run tests to verify pass (including existing suites)**

Run: `npm test -- tests/discord-oauth.test.ts tests/discord-link.test.ts tests/auth-routes.test.ts`
Expected: PASS (existing suites mock well-formed responses, so they stay green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/discord/oauth.ts tests/discord-oauth.test.ts tests/helpers/config.ts
git commit -m "feat: fail-closed validation for Discord OAuth responses"
```

---

### Task 2: sync_run service and ops webhook

**Files:**
- Create: `src/services/sync-run.ts`, `src/lib/ops-webhook.ts`
- Test: `tests/sync-run.test.ts`, `tests/ops-webhook.test.ts`

**Interfaces:**
- Consumes: `Db`, `Dbx`, `syncRun` table, `Config`.
- Produces:
  - `type JobResult = { status: "ok" | "partial" | "failed"; errorSummary?: string; counts?: Record<string, number>; retry?: boolean }`
  - `startSyncRun(dbx: Dbx, jobType: string): Promise<number>`; `finishSyncRun(dbx: Dbx, id: number, result: Omit<JobResult, "retry">): Promise<void>`
  - `runJob(db: Db, jobType: string, fn: () => Promise<JobResult>): Promise<JobResult>` — records start/finish around `fn`; on thrown error records `failed` and rethrows; when `result.retry` is true, records the result then throws `JobRetryError` so pg-boss retries. **Every job in Tasks 6–12 wraps its body in this.**
  - `class JobRetryError extends Error`
  - `postOpsWebhook(cfg: Config, content: string, fetchImpl?: typeof fetch): Promise<void>` — POSTs `{ content }` to `cfg.discord.opsWebhookUrl`; no-op when unset; **never throws** (alerting must not break jobs); content truncated to 1900 chars.

- [ ] **Step 1: Write failing tests**

`tests/sync-run.test.ts`:

```ts
import { desc } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { syncRun } from "@/db/schema";
import { JobRetryError, runJob } from "@/services/sync-run";
import { setupTestDb } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());

async function latestRun() {
  const rows = await ctx.db
    .select()
    .from(syncRun)
    .orderBy(desc(syncRun.id))
    .limit(1);
  return rows[0];
}

describe("runJob", () => {
  it("records an ok run with counts", async () => {
    await runJob(ctx.db, "membership", async () => ({
      status: "ok",
      counts: { resolved: 3 },
    }));
    const run = await latestRun();
    expect(run.jobType).toBe("membership");
    expect(run.status).toBe("ok");
    expect(run.finishedAt).not.toBeNull();
    expect(run.counts).toEqual({ resolved: 3 });
  });

  it("records failed and rethrows on unexpected errors", async () => {
    await expect(
      runJob(ctx.db, "contacts", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const run = await latestRun();
    expect(run.status).toBe("failed");
    expect(run.errorSummary).toContain("boom");
  });

  it("records the result then throws JobRetryError when retry is requested", async () => {
    await expect(
      runJob(ctx.db, "wanderer", async () => ({
        status: "partial",
        errorSummary: "2 transient failures",
        retry: true,
      })),
    ).rejects.toBeInstanceOf(JobRetryError);
    const run = await latestRun();
    expect(run.status).toBe("partial");
    expect(run.errorSummary).toBe("2 transient failures");
  });

  it("records failed WITHOUT throwing for permanent-config results", async () => {
    const result = await runJob(ctx.db, "discord-roles", async () => ({
      status: "failed",
      errorSummary: "managed role ids are not distinct",
    }));
    expect(result.status).toBe("failed");
    const run = await latestRun();
    expect(run.status).toBe("failed");
  });
});
```

`tests/ops-webhook.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { postOpsWebhook } from "@/lib/ops-webhook";
import { testConfig } from "./helpers/config";

describe("postOpsWebhook", () => {
  it("posts content to the configured webhook", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 204 }));
    await postOpsWebhook(testConfig(), "job failed", fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://discord.example/webhook");
    expect(JSON.parse(init.body as string)).toEqual({ content: "job failed" });
  });

  it("is a no-op when no webhook is configured", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 204 }));
    const cfg = testConfig({ DISCORD_OPS_WEBHOOK_URL: "" });
    await postOpsWebhook(cfg, "x", fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never throws, even when the post fails", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    await expect(postOpsWebhook(testConfig(), "x", fetchImpl)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/sync-run.test.ts tests/ops-webhook.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`src/services/sync-run.ts`:

```ts
import { eq } from "drizzle-orm";
import type { Db, Dbx } from "@/db";
import { syncRun } from "@/db/schema";

export type JobResult = {
  status: "ok" | "partial" | "failed";
  errorSummary?: string;
  counts?: Record<string, number>;
  /** When true, runJob throws JobRetryError after recording so pg-boss retries. */
  retry?: boolean;
};

export class JobRetryError extends Error {}

export async function startSyncRun(dbx: Dbx, jobType: string): Promise<number> {
  const [row] = await dbx.insert(syncRun).values({ jobType }).returning();
  return row.id;
}

export async function finishSyncRun(
  dbx: Dbx,
  id: number,
  result: Omit<JobResult, "retry">,
): Promise<void> {
  await dbx
    .update(syncRun)
    .set({
      finishedAt: new Date(),
      status: result.status,
      errorSummary: result.errorSummary ?? null,
      counts: result.counts ?? null,
    })
    .where(eq(syncRun.id, id));
}

/**
 * Uniform job wrapper: one sync_run row per execution. Transient trouble is
 * reported via result.retry (recorded, then thrown as JobRetryError so pg-boss
 * retries the idempotent job); permanent/config failures return status
 * "failed" WITHOUT retry so they don't retry-loop.
 */
export async function runJob(
  db: Db,
  jobType: string,
  fn: () => Promise<JobResult>,
): Promise<JobResult> {
  const id = await startSyncRun(db, jobType);
  let result: JobResult;
  try {
    result = await fn();
  } catch (err) {
    await finishSyncRun(db, id, {
      status: "failed",
      errorSummary: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  await finishSyncRun(db, id, result);
  if (result.retry) {
    throw new JobRetryError(`${jobType}: ${result.errorSummary ?? "transient failures"}`);
  }
  return result;
}
```

`src/lib/ops-webhook.ts`:

```ts
import type { Config } from "@/config";

/** Posts to the optional Discord ops webhook. Never throws — alerting must not break jobs. */
export async function postOpsWebhook(
  cfg: Config,
  content: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = cfg.discord.opsWebhookUrl;
  if (!url) return;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: content.slice(0, 1900) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error(`ops webhook post failed (${res.status})`);
  } catch (err) {
    console.error("ops webhook post failed", err);
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- tests/sync-run.test.ts tests/ops-webhook.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/sync-run.ts src/lib/ops-webhook.ts tests/sync-run.test.ts tests/ops-webhook.test.ts
git commit -m "feat: sync_run job wrapper and ops webhook"
```

---

### Task 3: ESI client with error-limit throttling

**Files:**
- Create: `src/lib/esi/client.ts`, `src/core/chunk.ts`
- Test: `tests/esi-client.test.ts`

**Interfaces:**
- Consumes: `classifyEsiError` from `src/core/errors.ts`.
- Produces:
  - `chunk<T>(items: T[], size: number): T[][]` in `src/core/chunk.ts`.
  - `class EsiError extends Error { status: number; kind: "transient" | "permanent" | "needs_reauth" }`
  - `createEsiClient(opts?: { fetchImpl?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void>; errorBudgetFloor?: number }): EsiClient` and `type EsiClient = ReturnType<typeof createEsiClient>` with methods:
    - `postAffiliation(ids: number[]): Promise<Array<{ characterId: number; corporationId: number; allianceId: number | null }>>` (public endpoint, ≤500 ids per call — throws if given more; chunking is the caller's job)
    - `getContactLabels(characterId: number, accessToken: string): Promise<Array<{ labelId: number; labelName: string }>>`
    - `getAllContacts(characterId: number, accessToken: string): Promise<EsiContact[]>` — reads ALL pages; the `X-Pages` header is REQUIRED and must be a positive integer (missing/malformed/zero → reject: an unknown page count means an unknown contact set, and the downstream diff deletes); ANY page failure rejects the whole call (partial reads are unsafe for destructive diffs)
    - `addContacts(characterId, accessToken, contactIds: number[], standing: number, labelIds: number[]): Promise<void>` (chunks of 100)
    - `editContacts(...same signature as addContacts): Promise<void>` (PUT, chunks of 100)
    - `deleteContacts(characterId, accessToken, contactIds: number[]): Promise<void>` (chunks of 20, query param)
  - `type EsiContact = { contactId: number; contactType: string; standing: number; labelIds: number[] }`
  - `type Affiliation = { characterId: number; corporationId: number; allianceId: number | null }`
- ESI etiquette: the client tracks `X-ESI-Error-Limit-Remain`/`-Reset` from every response; before a request, if the remaining budget is at or below the floor (default 5) and the reset is in the future, it sleeps until reset.

- [ ] **Step 1: Write failing tests**

`tests/esi-client.test.ts` (msw at the HTTP level):

```ts
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createEsiClient, EsiError } from "@/lib/esi/client";
import { chunk } from "@/core/chunk";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const BASE = "https://esi.evetech.net/latest";

describe("chunk", () => {
  it("splits into fixed-size chunks", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });
});

describe("postAffiliation", () => {
  it("maps fields and defaults missing alliance to null", async () => {
    server.use(
      http.post(`${BASE}/characters/affiliation/`, async ({ request }) => {
        expect(await request.json()).toEqual([1, 2]);
        return HttpResponse.json([
          { character_id: 1, corporation_id: 100, alliance_id: 99000001 },
          { character_id: 2, corporation_id: 200 },
        ]);
      }),
    );
    const esi = createEsiClient();
    expect(await esi.postAffiliation([1, 2])).toEqual([
      { characterId: 1, corporationId: 100, allianceId: 99000001 },
      { characterId: 2, corporationId: 200, allianceId: null },
    ]);
  });

  it("rejects more than 500 ids", async () => {
    const esi = createEsiClient();
    await expect(
      esi.postAffiliation(Array.from({ length: 501 }, (_, i) => i + 1)),
    ).rejects.toThrow(/500/);
  });

  it("throws a classified EsiError on failure", async () => {
    server.use(
      http.post(`${BASE}/characters/affiliation/`, () =>
        HttpResponse.json({ error: "rate limited" }, { status: 420 }),
      ),
    );
    const esi = createEsiClient();
    const err = await esi.postAffiliation([1]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EsiError);
    expect((err as EsiError).status).toBe(420);
    expect((err as EsiError).kind).toBe("transient");
  });

  it("fails closed on a malformed body", async () => {
    server.use(
      http.post(`${BASE}/characters/affiliation/`, () =>
        HttpResponse.json([{ character_id: "not-a-number" }]),
      ),
    );
    const esi = createEsiClient();
    await expect(esi.postAffiliation([1])).rejects.toThrow();
  });
});

describe("error-limit throttling", () => {
  it("pauses until reset when the error budget is low", async () => {
    let calls = 0;
    server.use(
      http.post(`${BASE}/characters/affiliation/`, () => {
        calls++;
        return HttpResponse.json([], {
          headers: {
            "X-ESI-Error-Limit-Remain": "3",
            "X-ESI-Error-Limit-Reset": "42",
          },
        });
      }),
    );
    const sleeps: number[] = [];
    let nowMs = 1_000_000;
    const esi = createEsiClient({
      now: () => nowMs,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
    });
    await esi.postAffiliation([1]); // response says remain=3 (≤ floor of 5)
    await esi.postAffiliation([2]); // must pause until reset first
    expect(calls).toBe(2);
    expect(sleeps).toEqual([42_000]);
  });
});

describe("contacts", () => {
  it("reads all pages before returning", async () => {
    const pages: Record<string, unknown[]> = {
      "1": [{ contact_id: 11, contact_type: "character", standing: 5, label_ids: [7] }],
      "2": [{ contact_id: 12, contact_type: "character", standing: 0 }],
    };
    server.use(
      http.get(`${BASE}/characters/90000001/contacts/`, ({ request }) => {
        const page = new URL(request.url).searchParams.get("page") ?? "1";
        return HttpResponse.json(pages[page], { headers: { "X-Pages": "2" } });
      }),
    );
    const esi = createEsiClient();
    expect(await esi.getAllContacts(90000001, "at")).toEqual([
      { contactId: 11, contactType: "character", standing: 5, labelIds: [7] },
      { contactId: 12, contactType: "character", standing: 0, labelIds: [] },
    ]);
  });

  it("fails closed on a missing or malformed X-Pages header", async () => {
    server.use(
      http.get(`${BASE}/characters/90000001/contacts/`, () =>
        HttpResponse.json([]), // no X-Pages header at all
      ),
    );
    const esi = createEsiClient();
    await expect(esi.getAllContacts(90000001, "at")).rejects.toThrow(/X-Pages/);
    server.use(
      http.get(`${BASE}/characters/90000001/contacts/`, () =>
        HttpResponse.json([], { headers: { "X-Pages": "abc" } }),
      ),
    );
    await expect(esi.getAllContacts(90000001, "at")).rejects.toThrow(/X-Pages/);
    server.use(
      http.get(`${BASE}/characters/90000001/contacts/`, () =>
        HttpResponse.json([], { headers: { "X-Pages": "0" } }),
      ),
    );
    await expect(esi.getAllContacts(90000001, "at")).rejects.toThrow(/X-Pages/);
  });

  it("rejects the whole read when any page fails", async () => {
    server.use(
      http.get(`${BASE}/characters/90000001/contacts/`, ({ request }) => {
        const page = new URL(request.url).searchParams.get("page") ?? "1";
        if (page === "2") return HttpResponse.json({ error: "boom" }, { status: 500 });
        return HttpResponse.json(
          [{ contact_id: 11, contact_type: "character", standing: 5 }],
          { headers: { "X-Pages": "2" } },
        );
      }),
    );
    const esi = createEsiClient();
    await expect(esi.getAllContacts(90000001, "at")).rejects.toBeInstanceOf(EsiError);
  });

  it("sends the bearer token and label/standing params on writes, chunked at 100", async () => {
    const bodies: number[][] = [];
    server.use(
      http.post(`${BASE}/characters/90000001/contacts/`, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer at");
        const url = new URL(request.url);
        expect(url.searchParams.get("standing")).toBe("5");
        expect(url.searchParams.getAll("label_ids")).toEqual(["7"]);
        bodies.push((await request.json()) as number[]);
        return HttpResponse.json([], { status: 201 });
      }),
    );
    const esi = createEsiClient();
    const ids = Array.from({ length: 150 }, (_, i) => i + 1);
    await esi.addContacts(90000001, "at", ids, 5, [7]);
    expect(bodies.map((b) => b.length)).toEqual([100, 50]);
  });

  it("chunks deletes at 20 via query params", async () => {
    const deletes: string[] = [];
    server.use(
      http.delete(`${BASE}/characters/90000001/contacts/`, ({ request }) => {
        deletes.push(new URL(request.url).searchParams.get("contact_ids") ?? "");
        return HttpResponse.json([]);
      }),
    );
    const esi = createEsiClient();
    await esi.deleteContacts(90000001, "at", Array.from({ length: 45 }, (_, i) => i + 1));
    expect(deletes).toHaveLength(3);
    expect(deletes[0].split(",")).toHaveLength(20);
    expect(deletes[2].split(",")).toHaveLength(5);
  });

  it("parses contact labels", async () => {
    server.use(
      http.get(`${BASE}/characters/90000001/contacts/labels/`, () =>
        HttpResponse.json([{ label_id: 7, label_name: "flygd" }]),
      ),
    );
    const esi = createEsiClient();
    expect(await esi.getContactLabels(90000001, "at")).toEqual([
      { labelId: 7, labelName: "flygd" },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/esi-client.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`src/core/chunk.ts`:

```ts
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
```

`src/lib/esi/client.ts`:

```ts
import { z } from "zod";
import { chunk } from "@/core/chunk";
import { classifyEsiError, type EsiErrorClass } from "@/core/errors";

const ESI_BASE = "https://esi.evetech.net/latest";
const WRITE_CHUNK = 100; // ESI POST/PUT contacts body limit
const DELETE_CHUNK = 20; // ESI DELETE contacts query limit
const AFFILIATION_MAX = 500;

export class EsiError extends Error {
  status: number;
  kind: EsiErrorClass;
  constructor(message: string, status: number, kind: EsiErrorClass) {
    super(message);
    this.status = status;
    this.kind = kind;
  }
}

const affiliationSchema = z.array(
  z.object({
    character_id: z.number().int(),
    corporation_id: z.number().int(),
    alliance_id: z.number().int().optional(),
  }),
);
const labelsSchema = z.array(
  z.object({ label_id: z.number().int(), label_name: z.string() }),
);
const contactsSchema = z.array(
  z.object({
    contact_id: z.number().int(),
    contact_type: z.string(),
    standing: z.number(),
    label_ids: z.array(z.number().int()).nullish(),
  }),
);

export type Affiliation = {
  characterId: number;
  corporationId: number;
  allianceId: number | null;
};
export type EsiContact = {
  contactId: number;
  contactType: string;
  standing: number;
  labelIds: number[];
};

export interface EsiClientOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Pause when the remaining ESI error budget is at or below this. */
  errorBudgetFloor?: number;
}

export function createEsiClient(opts: EsiClientOptions = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const floor = opts.errorBudgetFloor ?? 5;

  // ESI etiquette: honor X-ESI-Error-Limit-Remain/Reset across all calls.
  let remain = Number.POSITIVE_INFINITY;
  let resetAt = 0; // epoch ms

  async function request(
    path: string,
    init: RequestInit & { accessToken?: string } = {},
  ): Promise<Response> {
    if (remain <= floor && resetAt > now()) {
      await sleep(resetAt - now());
      remain = Number.POSITIVE_INFINITY;
    }
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(init.headers as Record<string, string> | undefined),
    };
    if (init.accessToken) headers.authorization = `Bearer ${init.accessToken}`;
    const res = await fetchImpl(`${ESI_BASE}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    const remainHeader = res.headers.get("x-esi-error-limit-remain");
    const resetHeader = res.headers.get("x-esi-error-limit-reset");
    if (remainHeader !== null) remain = Number(remainHeader);
    if (resetHeader !== null) resetAt = now() + Number(resetHeader) * 1000;
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as
        | { error?: string }
        | undefined;
      throw new EsiError(
        `ESI ${init.method ?? "GET"} ${path} failed (${res.status}${body?.error ? `: ${body.error}` : ""})`,
        res.status,
        classifyEsiError(res.status, body),
      );
    }
    return res;
  }

  async function postAffiliation(ids: number[]): Promise<Affiliation[]> {
    if (ids.length === 0) return [];
    if (ids.length > AFFILIATION_MAX) {
      throw new Error(`postAffiliation: max ${AFFILIATION_MAX} ids per call`);
    }
    const res = await request("/characters/affiliation/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ids),
    });
    return affiliationSchema.parse(await res.json()).map((a) => ({
      characterId: a.character_id,
      corporationId: a.corporation_id,
      allianceId: a.alliance_id ?? null,
    }));
  }

  async function getContactLabels(
    characterId: number,
    accessToken: string,
  ): Promise<Array<{ labelId: number; labelName: string }>> {
    const res = await request(`/characters/${characterId}/contacts/labels/`, {
      accessToken,
    });
    return labelsSchema
      .parse(await res.json())
      .map((l) => ({ labelId: l.label_id, labelName: l.label_name }));
  }

  /** Reads ALL pages; any page failure rejects the whole call. */
  async function getAllContacts(
    characterId: number,
    accessToken: string,
  ): Promise<EsiContact[]> {
    const first = await request(`/characters/${characterId}/contacts/?page=1`, {
      accessToken,
    });
    // Fail closed: an unknown page count means an unknown contact set, and the
    // downstream diff deletes. Never guess (spec: never remove on unknown state).
    const pagesHeader = first.headers.get("x-pages");
    const pages = Number(pagesHeader);
    if (pagesHeader === null || !Number.isInteger(pages) || pages < 1) {
      throw new EsiError(
        `ESI GET contacts: missing or invalid X-Pages header (${pagesHeader})`,
        0,
        "transient",
      );
    }
    const raw = contactsSchema.parse(await first.json()).slice();
    for (let page = 2; page <= pages; page++) {
      const res = await request(
        `/characters/${characterId}/contacts/?page=${page}`,
        { accessToken },
      );
      raw.push(...contactsSchema.parse(await res.json()));
    }
    return raw.map((c) => ({
      contactId: c.contact_id,
      contactType: c.contact_type,
      standing: c.standing,
      labelIds: c.label_ids ?? [],
    }));
  }

  function contactWriteParams(standing: number, labelIds: number[]): string {
    const params = new URLSearchParams({ standing: String(standing) });
    for (const l of labelIds) params.append("label_ids", String(l));
    return params.toString();
  }

  async function writeContacts(
    method: "POST" | "PUT",
    characterId: number,
    accessToken: string,
    contactIds: number[],
    standing: number,
    labelIds: number[],
  ): Promise<void> {
    for (const ids of chunk(contactIds, WRITE_CHUNK)) {
      await request(
        `/characters/${characterId}/contacts/?${contactWriteParams(standing, labelIds)}`,
        {
          method,
          accessToken,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(ids),
        },
      );
    }
  }

  return {
    postAffiliation,
    getContactLabels,
    getAllContacts,
    addContacts: (
      characterId: number,
      accessToken: string,
      contactIds: number[],
      standing: number,
      labelIds: number[],
    ) => writeContacts("POST", characterId, accessToken, contactIds, standing, labelIds),
    editContacts: (
      characterId: number,
      accessToken: string,
      contactIds: number[],
      standing: number,
      labelIds: number[],
    ) => writeContacts("PUT", characterId, accessToken, contactIds, standing, labelIds),
    deleteContacts: async (
      characterId: number,
      accessToken: string,
      contactIds: number[],
    ): Promise<void> => {
      for (const ids of chunk(contactIds, DELETE_CHUNK)) {
        await request(
          `/characters/${characterId}/contacts/?contact_ids=${ids.join(",")}`,
          { method: "DELETE", accessToken },
        );
      }
    },
  };
}

export type EsiClient = ReturnType<typeof createEsiClient>;
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- tests/esi-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/esi/client.ts src/core/chunk.ts tests/esi-client.test.ts
git commit -m "feat: throttled ESI client with fail-closed parsing"
```

---

### Task 4: Affiliation resolution (chunk + bisect) and tier decision

**Files:**
- Create: `src/core/affiliation.ts`, `src/core/tier.ts`
- Test: `tests/affiliation.test.ts`, `tests/tier.test.ts`

**Interfaces:**
- Consumes: `chunk` from `src/core/chunk.ts`; `EsiError`, `Affiliation` from `src/lib/esi/client.ts`.
- Produces:
  - `resolveAffiliations(ids: number[], post: (ids: number[]) => Promise<Affiliation[]>): Promise<AffiliationOutcome>` where `type AffiliationOutcome = { resolved: Map<number, { corporationId: number; allianceId: number | null }>; invalid: number[]; unresolved: number[] }`. Chunks at 500; **bisects ONLY on `EsiError` with status 400** down to single ids (those become `invalid`); any other failure marks the whole chunk `unresolved` (never flagged). Ids a successful response silently omits are `unresolved`.
  - `decideTier(input: { tier: "flygd" | "blue" | "green"; tierLocked: boolean; mainConfirmed: boolean; mainInAlliance: boolean }): "flygd" | "green" | null` — null when locked, unconfirmed, or already at the desired tier. Any unlocked account is system-managed, so an unlocked Blue account converges to flygd/green (spec tier state machine).

- [ ] **Step 1: Write failing tests**

`tests/affiliation.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { resolveAffiliations } from "@/core/affiliation";
import { EsiError, type Affiliation } from "@/lib/esi/client";

const okFor = (ids: number[]): Affiliation[] =>
  ids.map((id) => ({ characterId: id, corporationId: id * 10, allianceId: 99000001 }));

describe("resolveAffiliations", () => {
  it("resolves a clean batch", async () => {
    const out = await resolveAffiliations([1, 2, 3], async (ids) => okFor(ids));
    expect(out.resolved.size).toBe(3);
    expect(out.resolved.get(2)).toEqual({ corporationId: 20, allianceId: 99000001 });
    expect(out.invalid).toEqual([]);
    expect(out.unresolved).toEqual([]);
  });

  it("submits in chunks of at most 500", async () => {
    const sizes: number[] = [];
    const ids = Array.from({ length: 1100 }, (_, i) => i + 1);
    await resolveAffiliations(ids, async (batch) => {
      sizes.push(batch.length);
      return okFor(batch);
    });
    expect(sizes).toEqual([500, 500, 100]);
  });

  it("bisects deterministic 400s down to the bad ids only", async () => {
    const bad = new Set([2, 5]);
    const post = vi.fn(async (ids: number[]): Promise<Affiliation[]> => {
      if (ids.some((id) => bad.has(id))) {
        throw new EsiError("bad id", 400, "permanent");
      }
      return okFor(ids);
    });
    const out = await resolveAffiliations([1, 2, 3, 4, 5, 6], post);
    expect([...out.invalid].sort((a, b) => a - b)).toEqual([2, 5]);
    expect([...out.resolved.keys()].sort((a, b) => a - b)).toEqual([1, 3, 4, 6]);
    expect(out.unresolved).toEqual([]);
  });

  it("NEVER bisects or flags on transient failures", async () => {
    const post = vi.fn(async (): Promise<Affiliation[]> => {
      throw new EsiError("rate limited", 420, "transient");
    });
    const out = await resolveAffiliations([1, 2, 3], post);
    expect(out.invalid).toEqual([]);
    expect([...out.unresolved].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(post).toHaveBeenCalledTimes(1); // no bisection attempts
  });

  it("treats non-400 permanent errors as unresolved, not invalid", async () => {
    const post = async (): Promise<Affiliation[]> => {
      throw new EsiError("not found", 404, "permanent");
    };
    const out = await resolveAffiliations([1, 2], post);
    expect(out.invalid).toEqual([]);
    expect(out.unresolved).toEqual([1, 2]);
  });

  it("marks ids omitted from a successful response as unresolved", async () => {
    const out = await resolveAffiliations([1, 2], async () => okFor([1]));
    expect([...out.resolved.keys()]).toEqual([1]);
    expect(out.unresolved).toEqual([2]);
  });
});
```

`tests/tier.test.ts` (table-driven):

```ts
import { describe, expect, it } from "vitest";
import { decideTier } from "@/core/tier";

describe("decideTier", () => {
  const cases: Array<{
    name: string;
    tier: "flygd" | "blue" | "green";
    tierLocked: boolean;
    mainConfirmed: boolean;
    mainInAlliance: boolean;
    expected: "flygd" | "green" | null;
  }> = [
    { name: "green + main in alliance → flygd", tier: "green", tierLocked: false, mainConfirmed: true, mainInAlliance: true, expected: "flygd" },
    { name: "flygd + main left alliance → green", tier: "flygd", tierLocked: false, mainConfirmed: true, mainInAlliance: false, expected: "green" },
    { name: "flygd + main in alliance → no change", tier: "flygd", tierLocked: false, mainConfirmed: true, mainInAlliance: true, expected: null },
    { name: "green + main out → no change", tier: "green", tierLocked: false, mainConfirmed: true, mainInAlliance: false, expected: null },
    { name: "unlocked blue converges to flygd", tier: "blue", tierLocked: false, mainConfirmed: true, mainInAlliance: true, expected: "flygd" },
    { name: "unlocked blue converges to green", tier: "blue", tierLocked: false, mainConfirmed: true, mainInAlliance: false, expected: "green" },
    { name: "locked accounts are never touched", tier: "flygd", tierLocked: true, mainConfirmed: true, mainInAlliance: false, expected: null },
    { name: "locked blue stays blue", tier: "blue", tierLocked: true, mainConfirmed: true, mainInAlliance: true, expected: null },
    { name: "unconfirmed main is never transitioned", tier: "flygd", tierLocked: false, mainConfirmed: false, mainInAlliance: false, expected: null },
    { name: "unconfirmed main never promotes either", tier: "green", tierLocked: false, mainConfirmed: false, mainInAlliance: true, expected: null },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(
        decideTier({
          tier: c.tier,
          tierLocked: c.tierLocked,
          mainConfirmed: c.mainConfirmed,
          mainInAlliance: c.mainInAlliance,
        }),
      ).toBe(c.expected);
    });
  }
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/affiliation.test.ts tests/tier.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`src/core/affiliation.ts`:

```ts
import { chunk } from "@/core/chunk";
import { EsiError, type Affiliation } from "@/lib/esi/client";

export type AffiliationOutcome = {
  resolved: Map<number, { corporationId: number; allianceId: number | null }>;
  /** Deterministic 400 on a single id — safe to flag affiliation_invalid. */
  invalid: number[];
  /** Transient or ambiguous failures — never flagged, retried next run. */
  unresolved: number[];
};

const CHUNK_SIZE = 500;

export async function resolveAffiliations(
  ids: number[],
  post: (ids: number[]) => Promise<Affiliation[]>,
): Promise<AffiliationOutcome> {
  const out: AffiliationOutcome = { resolved: new Map(), invalid: [], unresolved: [] };
  for (const batch of chunk(ids, CHUNK_SIZE)) {
    await resolveChunk(batch, post, out);
  }
  return out;
}

async function resolveChunk(
  ids: number[],
  post: (ids: number[]) => Promise<Affiliation[]>,
  out: AffiliationOutcome,
): Promise<void> {
  if (ids.length === 0) return;
  try {
    const rows = await post(ids);
    const returned = new Set<number>();
    for (const r of rows) {
      returned.add(r.characterId);
      out.resolved.set(r.characterId, {
        corporationId: r.corporationId,
        allianceId: r.allianceId,
      });
    }
    for (const id of ids) if (!returned.has(id)) out.unresolved.push(id);
  } catch (err) {
    // Bisect ONLY deterministic invalid-request responses. Anything else
    // (420/5xx/network, or odd permanent statuses) must never flag characters.
    if (err instanceof EsiError && err.status === 400) {
      if (ids.length === 1) {
        out.invalid.push(ids[0]);
        return;
      }
      const mid = Math.ceil(ids.length / 2);
      await resolveChunk(ids.slice(0, mid), post, out);
      await resolveChunk(ids.slice(mid), post, out);
      return;
    }
    out.unresolved.push(...ids);
  }
}
```

`src/core/tier.ts`:

```ts
export type Tier = "flygd" | "blue" | "green";

/**
 * Membership rule: unlocked accounts are system-managed — the desired tier is
 * flygd when the main is in the configured alliance, green otherwise (this is
 * how an unlocked Blue converges after "return to auto"). Transitions require
 * a CONFIRMED affiliation read of the main in this run. Returns the tier to
 * set, or null for no change.
 */
export function decideTier(input: {
  tier: Tier;
  tierLocked: boolean;
  mainConfirmed: boolean;
  mainInAlliance: boolean;
}): "flygd" | "green" | null {
  if (input.tierLocked || !input.mainConfirmed) return null;
  const desired = input.mainInAlliance ? "flygd" : "green";
  return input.tier === desired ? null : desired;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- tests/affiliation.test.ts tests/tier.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/affiliation.ts src/core/tier.ts tests/affiliation.test.ts tests/tier.test.ts
git commit -m "feat: affiliation chunk/bisect resolution and tier decision rule"
```

---

### Task 5: Token access service

**Files:**
- Create: `src/services/tokens.ts`, `tests/helpers/seed.ts`
- Test: `tests/tokens.test.ts`

**Interfaces:**
- Consumes: `decryptToken`/`encryptToken` (`src/lib/crypto.ts`), `refreshEveToken`/`EveSsoError` (`src/lib/esi/sso.ts`), `classifyOAuthError` (`src/core/errors.ts`), `logAudit`.
- Produces:
  - `type CharacterTokenRow = { id: number; refreshTokenEnc: string | null; tokenStatus: "valid" | "invalid" | "needs_reauth" | "missing" }`
  - `getFreshAccessToken(db: Db, cfg: Config, ch: CharacterTokenRow, fetchImpl?: typeof fetch): Promise<AccessTokenResult>` where `type AccessTokenResult = { ok: true; accessToken: string } | { ok: false; reason: "no_token" | "invalid" | "transient"; detail?: string }` — refreshes via `refreshEveToken`, persists the rotated refresh token on success. Permanent OAuth failures AND malformed stored blobs (carry-over: `decryptToken` throws uncleanly) mark `token_status: invalid` + audit `token.invalidated`; transient failures change no state. Used by Tasks 8 and 11.
  - **Concurrency (EVE rotates refresh tokens on every use, and overlapping jobs may race):** the success path persists with compare-and-swap on the blob that was read (`WHERE refresh_token_enc = <old>`); a lost race keeps the first writer's stored token and still returns `ok`. The permanent-failure path re-reads the row first: if the stored blob changed since our read, a concurrent job already rotated it — `invalid_grant` on the OLD token says nothing about the NEW one, so return `transient` and do NOT invalidate.
  - Test seed helpers in `tests/helpers/seed.ts`: `seedAccount(db, opts?)` and `seedCharacter(db, cfg, opts)` (exact signatures in code below). Later test tasks consume these.

- [ ] **Step 1: Write the seed helper and failing test**

`tests/helpers/seed.ts`:

```ts
import { eq } from "drizzle-orm";
import type { Config } from "@/config";
import type { Db } from "@/db";
import { account, character, discordLink } from "@/db/schema";
import { encryptToken } from "@/lib/crypto";

export async function seedAccount(
  db: Db,
  opts: {
    tier?: "flygd" | "blue" | "green";
    tierLocked?: boolean;
    discordUserId?: string;
  } = {},
) {
  const [acc] = await db
    .insert(account)
    .values({ tier: opts.tier ?? "green", tierLocked: opts.tierLocked ?? false })
    .returning();
  if (opts.discordUserId) {
    await db
      .insert(discordLink)
      .values({ accountId: acc.id, discordUserId: opts.discordUserId });
  }
  return acc;
}

export async function seedCharacter(
  db: Db,
  cfg: Config,
  opts: {
    id: number;
    accountId: string;
    name?: string;
    ownerHash?: string;
    /** null → no stored token; otherwise encrypted with the test key. */
    refreshToken?: string | null;
    scopes?: string[];
    tokenStatus?: "valid" | "invalid" | "needs_reauth" | "missing";
    /** Also set as the account's main character. */
    main?: boolean;
    allianceId?: number | null;
    affiliationInvalid?: boolean;
  },
) {
  const [ch] = await db
    .insert(character)
    .values({
      id: opts.id,
      accountId: opts.accountId,
      name: opts.name ?? `Char ${opts.id}`,
      ownerHash: opts.ownerHash ?? `oh-${opts.id}`,
      refreshTokenEnc:
        opts.refreshToken === null
          ? null
          : encryptToken(opts.refreshToken ?? "refresh", cfg.tokenEncryptionKey),
      scopes: opts.scopes ?? [...cfg.eveSso.scopes],
      tokenStatus: opts.tokenStatus ?? "valid",
      allianceId: opts.allianceId ?? null,
      affiliationInvalid: opts.affiliationInvalid ?? false,
    })
    .returning();
  if (opts.main) {
    await db
      .update(account)
      .set({ mainCharacterId: opts.id })
      .where(eq(account.id, opts.accountId));
  }
  return ch;
}
```

`tests/tokens.test.ts`:

```ts
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLog, character } from "@/db/schema";
import { decryptToken, encryptToken } from "@/lib/crypto";
import { getFreshAccessToken } from "@/services/tokens";
import { setupTestDb } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";

const cfg = testConfig();

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(async () => {
  await ctx.db.execute(sql`
    TRUNCATE account, "character", discord_link, session, bootstrap_admin_grant,
      outbox, oauth_transaction, contact_sync_state, sync_run,
      wanderer_acl_observation, audit_log RESTART IDENTITY CASCADE
  `);
});

const tokenJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

async function seed(opts: Partial<Parameters<typeof seedCharacter>[2]> = {}) {
  const acc = await seedAccount(ctx.db);
  return seedCharacter(ctx.db, cfg, { id: 90000001, accountId: acc.id, ...opts });
}

async function getChar(id: number) {
  const rows = await ctx.db.select().from(character).where(eq(character.id, id));
  return rows[0];
}

describe("getFreshAccessToken", () => {
  it("returns the access token and persists the rotated refresh token", async () => {
    const ch = await seed({ refreshToken: "old-rt" });
    const fetchImpl = (async () =>
      tokenJson({ access_token: "new-at", refresh_token: "new-rt" })) as typeof fetch;
    const r = await getFreshAccessToken(ctx.db, cfg, ch, fetchImpl);
    expect(r).toEqual({ ok: true, accessToken: "new-at" });
    const updated = await getChar(90000001);
    expect(decryptToken(updated.refreshTokenEnc as string, cfg.tokenEncryptionKey)).toBe("new-rt");
  });

  it("marks token invalid + audits on permanent OAuth errors", async () => {
    const ch = await seed({});
    const fetchImpl = (async () =>
      tokenJson({ error: "invalid_grant" }, 400)) as typeof fetch;
    const r = await getFreshAccessToken(ctx.db, cfg, ch, fetchImpl);
    expect(r).toMatchObject({ ok: false, reason: "invalid" });
    expect((await getChar(90000001)).tokenStatus).toBe("invalid");
    const audits = await ctx.db.select().from(auditLog);
    expect(audits.some((a) => a.action === "token.invalidated")).toBe(true);
  });

  it("changes NO state on transient errors", async () => {
    const ch = await seed({});
    const fetchImpl = (async () =>
      tokenJson({ error: "temporarily_unavailable" }, 503)) as typeof fetch;
    const r = await getFreshAccessToken(ctx.db, cfg, ch, fetchImpl);
    expect(r).toMatchObject({ ok: false, reason: "transient" });
    expect((await getChar(90000001)).tokenStatus).toBe("valid");
  });

  it("maps a malformed stored blob to a clean invalid (carry-over)", async () => {
    const ch = await seed({});
    await ctx.db
      .update(character)
      .set({ refreshTokenEnc: "not.a.blob" })
      .where(eq(character.id, 90000001));
    const r = await getFreshAccessToken(
      ctx.db,
      cfg,
      { ...ch, refreshTokenEnc: "not.a.blob" },
      (async () => tokenJson({})) as typeof fetch,
    );
    expect(r).toMatchObject({ ok: false, reason: "invalid", detail: "malformed_token_blob" });
    expect((await getChar(90000001)).tokenStatus).toBe("invalid");
  });

  it("returns no_token for missing or already-invalid tokens", async () => {
    const ch = await seed({ refreshToken: null, tokenStatus: "missing" });
    const r = await getFreshAccessToken(ctx.db, cfg, ch, (async () =>
      tokenJson({})) as typeof fetch);
    expect(r).toEqual({ ok: false, reason: "no_token" });
  });

  it("does not clobber a concurrently rotated token on success (CAS)", async () => {
    const stale = await seed({ refreshToken: "old-rt" }); // row as WE read it
    // another job rotates underneath us before our refresh completes
    const currentBlob = encryptToken("current-rt", cfg.tokenEncryptionKey);
    await ctx.db
      .update(character)
      .set({ refreshTokenEnc: currentBlob })
      .where(eq(character.id, 90000001));
    const fetchImpl = (async () =>
      tokenJson({ access_token: "our-at", refresh_token: "our-rt" })) as typeof fetch;
    const r = await getFreshAccessToken(ctx.db, cfg, stale, fetchImpl);
    expect(r).toEqual({ ok: true, accessToken: "our-at" }); // our access token still works
    const after = await getChar(90000001);
    // …but the FIRST writer's stored refresh token wins
    expect(decryptToken(after.refreshTokenEnc as string, cfg.tokenEncryptionKey)).toBe("current-rt");
  });

  it("skips invalidation when the blob rotated during a failed refresh", async () => {
    const stale = await seed({ refreshToken: "old-rt" });
    await ctx.db
      .update(character)
      .set({ refreshTokenEnc: encryptToken("current-rt", cfg.tokenEncryptionKey) })
      .where(eq(character.id, 90000001));
    // invalid_grant for the OLD token proves nothing about the NEW one
    const fetchImpl = (async () =>
      tokenJson({ error: "invalid_grant" }, 400)) as typeof fetch;
    const r = await getFreshAccessToken(ctx.db, cfg, stale, fetchImpl);
    expect(r).toMatchObject({ ok: false, reason: "transient" });
    expect((await getChar(90000001)).tokenStatus).toBe("valid"); // NOT invalidated
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test -- tests/tokens.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/services/tokens.ts`:

```ts
import { and, eq } from "drizzle-orm";
import type { Config } from "@/config";
import type { Db } from "@/db";
import { character } from "@/db/schema";
import { classifyOAuthError } from "@/core/errors";
import { decryptToken, encryptToken } from "@/lib/crypto";
import { EveSsoError, refreshEveToken } from "@/lib/esi/sso";
import { logAudit } from "@/services/audit";

export type CharacterTokenRow = {
  id: number;
  refreshTokenEnc: string | null;
  tokenStatus: "valid" | "invalid" | "needs_reauth" | "missing";
};

export type AccessTokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: "no_token" | "invalid" | "transient"; detail?: string };

async function markInvalid(db: Db, characterId: number, reason: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(character)
      .set({ tokenStatus: "invalid" })
      .where(eq(character.id, characterId));
    await logAudit(tx, {
      actor: "system",
      action: "token.invalidated",
      target: String(characterId),
      details: { reason },
    });
  });
}

/**
 * Refreshes the character's token and persists the rotated refresh token.
 * Permanent OAuth failures — and malformed stored blobs — mark token_status
 * invalid; transient failures change no state (spec: Error handling).
 */
export async function getFreshAccessToken(
  db: Db,
  cfg: Config,
  ch: CharacterTokenRow,
  fetchImpl: typeof fetch = fetch,
): Promise<AccessTokenResult> {
  if (!ch.refreshTokenEnc || ch.tokenStatus === "invalid" || ch.tokenStatus === "missing") {
    return { ok: false, reason: "no_token" };
  }
  let refreshToken: string;
  try {
    refreshToken = decryptToken(ch.refreshTokenEnc, cfg.tokenEncryptionKey);
  } catch {
    await markInvalid(db, ch.id, "malformed_token_blob");
    return { ok: false, reason: "invalid", detail: "malformed_token_blob" };
  }
  try {
    const r = await refreshEveToken(cfg, refreshToken, fetchImpl);
    // Compare-and-swap on the blob we read: EVE rotates refresh tokens on
    // every use, so a concurrent job may have rotated first. If the CAS
    // misses, keep the first writer's stored token — our access token is
    // still valid for this run.
    await db
      .update(character)
      .set({ refreshTokenEnc: encryptToken(r.refreshToken, cfg.tokenEncryptionKey) })
      .where(
        and(eq(character.id, ch.id), eq(character.refreshTokenEnc, ch.refreshTokenEnc)),
      );
    return { ok: true, accessToken: r.accessToken };
  } catch (err) {
    if (
      err instanceof EveSsoError &&
      classifyOAuthError(err.oauthError, err.status) === "permanent"
    ) {
      // invalid_grant on the OLD blob says nothing about a token another job
      // rotated in the meantime — re-read before invalidating.
      const [current] = await db
        .select({ refreshTokenEnc: character.refreshTokenEnc })
        .from(character)
        .where(eq(character.id, ch.id));
      if (!current || current.refreshTokenEnc !== ch.refreshTokenEnc) {
        return { ok: false, reason: "transient", detail: "concurrent rotation" };
      }
      await markInvalid(db, ch.id, err.oauthError ?? `status_${err.status}`);
      return { ok: false, reason: "invalid", detail: err.oauthError };
    }
    return {
      ok: false,
      reason: "transient",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npm test -- tests/tokens.test.ts`
Expected: PASS. (Note: the transient case relies on `classifyOAuthError("temporarily_unavailable", 503)` → transient — already covered by `tests/errors.test.ts`.)

- [ ] **Step 5: Commit**

```bash
git add src/services/tokens.ts tests/tokens.test.ts tests/helpers/seed.ts
git commit -m "feat: token refresh service with permanent/transient classification"
```

---

### Task 6: Membership verification job

**Files:**
- Create: `src/jobs/membership.ts`
- Test: `tests/membership-job.test.ts`

**Interfaces:**
- Consumes: `resolveAffiliations`, `decideTier`, `EsiClient` (`postAffiliation` only), `runJob`/`JobResult`/`JobRetryError`, `logAudit`, `enqueueSync`.
- Produces: `runMembershipJob(deps: { db: Db; cfg: Config; esi: Pick<EsiClient, "postAffiliation"> }, opts?: { accountId?: string; recheckInvalid?: boolean }): Promise<JobResult>` — job type `"membership"`. Behavior:
  - Refreshes affiliation columns for all resolved characters; flags deterministic-400 ids `affiliation_invalid` (audit `character.affiliation_invalid` on new flags); resolved ids clear the flag (weekly recheck / admin recheck pass `recheckInvalid: true` to include flagged ids).
  - Tier pass skips `tier_locked` and null-main accounts; transitions only on a confirmed read of the MAIN; each transition commits tier update + audit `tier.changed` + `outbox` row in ONE transaction with the account row locked and re-checked.
  - Any `unresolved` ids → `partial` + retry (throws `JobRetryError`); otherwise `ok`. Counts: `checked`, `resolved`, `invalid`, `unresolved`, `promoted`, `demoted`.

- [ ] **Step 1: Write failing test**

`tests/membership-job.test.ts`:

```ts
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { account, auditLog, character, outbox } from "@/db/schema";
import { runMembershipJob } from "@/jobs/membership";
import { EsiError, type Affiliation } from "@/lib/esi/client";
import { JobRetryError } from "@/services/sync-run";
import { setupTestDb } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";

const cfg = testConfig(); // allianceId 99000001

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(async () => {
  await ctx.db.execute(sql`
    TRUNCATE account, "character", discord_link, session, bootstrap_admin_grant,
      outbox, oauth_transaction, contact_sync_state, sync_run,
      wanderer_acl_observation, audit_log RESTART IDENTITY CASCADE
  `);
});

/** ESI fake: every id resolves into the given alliance (or none). */
const esiWith = (alliances: Record<number, number | null>) => ({
  postAffiliation: async (ids: number[]): Promise<Affiliation[]> =>
    ids.map((id) => ({
      characterId: id,
      corporationId: 1000,
      allianceId: alliances[id] ?? null,
    })),
});

async function getAccount(id: string) {
  const rows = await ctx.db.select().from(account).where(eq(account.id, id));
  return rows[0];
}

describe("runMembershipJob", () => {
  it("promotes green → flygd on a confirmed main in alliance, transactionally with the outbox row", async () => {
    const acc = await seedAccount(ctx.db, { tier: "green" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
    const result = await runMembershipJob(
      { db: ctx.db, cfg, esi: esiWith({ 1: 99000001 }) },
    );
    expect(result.status).toBe("ok");
    expect(result.counts).toMatchObject({ promoted: 1, demoted: 0 });
    const after = await getAccount(acc.id);
    expect(after.tier).toBe("flygd");
    expect(after.tierChangedBy).toBe("system");
    const outboxRows = await ctx.db.select().from(outbox);
    expect(outboxRows.map((r) => r.payload)).toContainEqual({
      kind: "account",
      accountId: acc.id,
    });
    const audits = await ctx.db.select().from(auditLog);
    expect(
      audits.some((a) => a.action === "tier.changed" && a.target === acc.id),
    ).toBe(true);
  });

  it("demotes flygd → green when the main left the alliance", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, { id: 2, accountId: acc.id, main: true });
    await runMembershipJob({ db: ctx.db, cfg, esi: esiWith({ 2: null }) });
    expect((await getAccount(acc.id)).tier).toBe("green");
  });

  it("never touches tier_locked accounts", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd", tierLocked: true });
    await seedCharacter(ctx.db, cfg, { id: 3, accountId: acc.id, main: true });
    await runMembershipJob({ db: ctx.db, cfg, esi: esiWith({ 3: null }) });
    expect((await getAccount(acc.id)).tier).toBe("flygd");
  });

  it("skips null-main accounts", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, { id: 4, accountId: acc.id }); // not main
    await runMembershipJob({ db: ctx.db, cfg, esi: esiWith({ 4: null }) });
    expect((await getAccount(acc.id)).tier).toBe("flygd");
  });

  it("leaves accounts with unresolved mains untouched and retries", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, { id: 5, accountId: acc.id, main: true });
    const esi = {
      postAffiliation: async (): Promise<Affiliation[]> => {
        throw new EsiError("esi down", 503, "transient");
      },
    };
    await expect(
      runMembershipJob({ db: ctx.db, cfg, esi }),
    ).rejects.toBeInstanceOf(JobRetryError);
    expect((await getAccount(acc.id)).tier).toBe("flygd"); // an ESI outage can never mass-demote
  });

  it("flags only bisected 400 ids as affiliation_invalid and audits them", async () => {
    const acc = await seedAccount(ctx.db, { tier: "green" });
    await seedCharacter(ctx.db, cfg, { id: 6, accountId: acc.id, main: true });
    await seedCharacter(ctx.db, cfg, { id: 7, accountId: acc.id });
    const esi = {
      postAffiliation: async (ids: number[]): Promise<Affiliation[]> => {
        if (ids.includes(7)) throw new EsiError("bad id", 400, "permanent");
        return ids.map((id) => ({ characterId: id, corporationId: 1, allianceId: 99000001 }));
      },
    };
    const result = await runMembershipJob({ db: ctx.db, cfg, esi });
    expect(result.counts).toMatchObject({ invalid: 1, promoted: 1 });
    const rows = await ctx.db.select().from(character).where(eq(character.id, 7));
    expect(rows[0].affiliationInvalid).toBe(true);
    const six = await ctx.db.select().from(character).where(eq(character.id, 6));
    expect(six[0].affiliationInvalid).toBe(false);
    expect(six[0].allianceId).toBe(99000001);
  });

  it("excludes flagged characters unless recheckInvalid is set", async () => {
    const acc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, { id: 8, accountId: acc.id, affiliationInvalid: true });
    const seen: number[][] = [];
    const esi = {
      postAffiliation: async (ids: number[]): Promise<Affiliation[]> => {
        seen.push(ids);
        return ids.map((id) => ({ characterId: id, corporationId: 1, allianceId: null }));
      },
    };
    await runMembershipJob({ db: ctx.db, cfg, esi });
    expect(seen.flat()).not.toContain(8);
    await runMembershipJob({ db: ctx.db, cfg, esi }, { recheckInvalid: true });
    expect(seen.flat()).toContain(8);
    // a successful recheck clears the flag
    const rows = await ctx.db.select().from(character).where(eq(character.id, 8));
    expect(rows[0].affiliationInvalid).toBe(false);
  });

  it("scopes to one account when accountId is passed", async () => {
    const a1 = await seedAccount(ctx.db, { tier: "green" });
    const a2 = await seedAccount(ctx.db, { tier: "green" });
    await seedCharacter(ctx.db, cfg, { id: 10, accountId: a1.id, main: true });
    await seedCharacter(ctx.db, cfg, { id: 11, accountId: a2.id, main: true });
    await runMembershipJob(
      { db: ctx.db, cfg, esi: esiWith({ 10: 99000001, 11: 99000001 }) },
      { accountId: a1.id },
    );
    expect((await getAccount(a1.id)).tier).toBe("flygd");
    expect((await getAccount(a2.id)).tier).toBe("green"); // untouched
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test -- tests/membership-job.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/jobs/membership.ts`:

```ts
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { Config } from "@/config";
import type { Db } from "@/db";
import { account, character } from "@/db/schema";
import { resolveAffiliations } from "@/core/affiliation";
import { decideTier } from "@/core/tier";
import type { EsiClient } from "@/lib/esi/client";
import { logAudit } from "@/services/audit";
import { enqueueSync } from "@/services/outbox";
import { runJob, type JobResult } from "@/services/sync-run";

export async function runMembershipJob(
  deps: { db: Db; cfg: Config; esi: Pick<EsiClient, "postAffiliation"> },
  opts: { accountId?: string; recheckInvalid?: boolean } = {},
): Promise<JobResult> {
  const { db, cfg, esi } = deps;
  return runJob(db, "membership", async () => {
    const chars = await db
      .select({
        id: character.id,
        accountId: character.accountId,
        affiliationInvalid: character.affiliationInvalid,
      })
      .from(character)
      .where(opts.accountId ? eq(character.accountId, opts.accountId) : undefined);
    // affiliation_invalid ids are excluded from batches; the weekly recheck
    // (and the admin recheck button) pass recheckInvalid to include them.
    const eligible = chars.filter((c) => opts.recheckInvalid || !c.affiliationInvalid);
    const outcome = await resolveAffiliations(
      eligible.map((c) => c.id),
      (ids) => esi.postAffiliation(ids),
    );

    const checkedAt = new Date();
    for (const [id, aff] of outcome.resolved) {
      await db
        .update(character)
        .set({
          corporationId: aff.corporationId,
          allianceId: aff.allianceId,
          affiliationCheckedAt: checkedAt,
          affiliationInvalid: false,
        })
        .where(eq(character.id, id));
    }
    if (outcome.invalid.length > 0) {
      const alreadyFlagged = new Set(
        chars.filter((c) => c.affiliationInvalid).map((c) => c.id),
      );
      await db
        .update(character)
        .set({ affiliationInvalid: true, affiliationCheckedAt: checkedAt })
        .where(inArray(character.id, outcome.invalid));
      for (const id of outcome.invalid.filter((i) => !alreadyFlagged.has(i))) {
        await logAudit(db, {
          actor: "system",
          action: "character.affiliation_invalid",
          target: String(id),
        });
      }
    }

    // Tier pass: skip locked and null-main accounts; transition only on a
    // confirmed read of the MAIN in this run (an ESI outage can never demote).
    const accounts = await db
      .select()
      .from(account)
      .where(
        and(
          opts.accountId ? eq(account.id, opts.accountId) : undefined,
          eq(account.tierLocked, false),
          isNotNull(account.mainCharacterId),
        ),
      );
    let promoted = 0;
    let demoted = 0;
    for (const acc of accounts) {
      const mainAff =
        acc.mainCharacterId === null
          ? undefined
          : outcome.resolved.get(acc.mainCharacterId);
      const next = decideTier({
        tier: acc.tier,
        tierLocked: acc.tierLocked,
        mainConfirmed: mainAff !== undefined,
        mainInAlliance: mainAff?.allianceId === cfg.allianceId,
      });
      if (!next) continue;
      // State change + downstream job trigger commit in ONE transaction.
      const applied = await db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(account)
          .where(eq(account.id, acc.id))
          .for("update");
        if (
          !locked ||
          locked.tierLocked ||
          locked.tier === next ||
          locked.mainCharacterId !== acc.mainCharacterId
        ) {
          return false; // changed underneath us — leave it to the next run
        }
        await tx
          .update(account)
          .set({ tier: next, tierChangedAt: new Date(), tierChangedBy: "system" })
          .where(eq(account.id, acc.id));
        await logAudit(tx, {
          actor: "system",
          action: "tier.changed",
          target: acc.id,
          details: {
            from: locked.tier,
            to: next,
            cause: next === "flygd" ? "main joined alliance" : "main left alliance",
          },
        });
        await enqueueSync(tx, { kind: "account", accountId: acc.id });
        return true;
      });
      if (!applied) continue;
      if (next === "flygd") promoted++;
      else demoted++;
    }

    const counts = {
      checked: eligible.length,
      resolved: outcome.resolved.size,
      invalid: outcome.invalid.length,
      unresolved: outcome.unresolved.length,
      promoted,
      demoted,
    };
    if (outcome.unresolved.length > 0) {
      return {
        status: "partial",
        errorSummary: `${outcome.unresolved.length} characters unresolved (transient)`,
        counts,
        retry: true,
      };
    }
    return { status: "ok", counts };
  });
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npm test -- tests/membership-job.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/jobs/membership.ts tests/membership-job.test.ts
git commit -m "feat: membership verification job with confirmed-read tier transitions"
```

---

### Task 7: Desired-set service and contacts diff

**Files:**
- Create: `src/services/desired.ts`, `src/core/contacts-diff.ts`
- Test: `tests/desired.test.ts`, `tests/contacts-diff.test.ts`

**Interfaces:**
- Consumes: schema tables; `Dbx`.
- Produces:
  - `type FlygdCharacter = { characterId: number; accountId: string; name: string; refreshTokenEnc: string | null; tokenStatus: "valid" | "invalid" | "needs_reauth" | "missing"; scopes: string[] }`
  - `getFlygdCharacters(dbx: Dbx): Promise<FlygdCharacter[]>` — every character of every FlyGD account: the derived desired standings/ACL set (Green/Blue accounts fall out; nothing is deleted from the DB).
  - `type ContactState = { contactId: number; standing: number; labelIds: number[] }`
  - `diffContacts(input: { desiredIds: number[]; standing: number; labelId: number; contacts: ContactState[] }): { add: number[]; update: Array<{ contactId: number; labelIds: number[] }>; remove: number[] }` — `desiredIds` must already exclude the target character itself. Label-ownership policy (accepted-destructive, aa-standingssync precedent): desired ids absent → `add`; present but missing our label or wrong standing → `update` with the PRESERVED label union (ESI PUT replaces `label_ids` wholesale — never clobber personal labels); contacts carrying our label but not desired → `remove`; contacts never carrying our label are NEVER touched.

- [ ] **Step 1: Write failing tests**

`tests/contacts-diff.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { diffContacts, type ContactState } from "@/core/contacts-diff";

const LABEL = 7;

const contact = (
  contactId: number,
  standing: number,
  labelIds: number[] = [],
): ContactState => ({ contactId, standing, labelIds });

describe("diffContacts", () => {
  it("adds desired ids that are absent", () => {
    const d = diffContacts({ desiredIds: [1, 2], standing: 5, labelId: LABEL, contacts: [] });
    expect(d).toEqual({ add: [1, 2], update: [], remove: [] });
  });

  it("leaves correct labeled contacts alone", () => {
    const d = diffContacts({
      desiredIds: [1],
      standing: 5,
      labelId: LABEL,
      contacts: [contact(1, 5, [LABEL])],
    });
    expect(d).toEqual({ add: [], update: [], remove: [] });
  });

  it("takes over an existing personal contact, preserving its labels", () => {
    const d = diffContacts({
      desiredIds: [1],
      standing: 5,
      labelId: LABEL,
      contacts: [contact(1, 0, [3])],
    });
    expect(d).toEqual({
      add: [],
      update: [{ contactId: 1, labelIds: [3, LABEL] }],
      remove: [],
    });
  });

  it("re-asserts standing on labeled contacts without duplicating the label", () => {
    const d = diffContacts({
      desiredIds: [1],
      standing: 5,
      labelId: LABEL,
      contacts: [contact(1, -10, [LABEL])],
    });
    expect(d).toEqual({
      add: [],
      update: [{ contactId: 1, labelIds: [LABEL] }],
      remove: [],
    });
  });

  it("removes only OUR labeled contacts that left the desired set", () => {
    const d = diffContacts({
      desiredIds: [1],
      standing: 5,
      labelId: LABEL,
      contacts: [
        contact(1, 5, [LABEL]),
        contact(2, 5, [LABEL]), // ours, no longer desired → delete
        contact(3, 10, []), // personal, unlabeled → NEVER touched
        contact(4, -5, [9]), // personal, other label → NEVER touched
      ],
    });
    expect(d).toEqual({ add: [], update: [], remove: [2] });
  });
});
```

`tests/desired.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getFlygdCharacters } from "@/services/desired";
import { setupTestDb } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";

const cfg = testConfig();

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(async () => {
  await ctx.db.execute(sql`
    TRUNCATE account, "character", discord_link, session, bootstrap_admin_grant,
      outbox, oauth_transaction, contact_sync_state, sync_run,
      wanderer_acl_observation, audit_log RESTART IDENTITY CASCADE
  `);
});

describe("getFlygdCharacters", () => {
  it("returns every character of every flygd account and nothing else", async () => {
    const flygd = await seedAccount(ctx.db, { tier: "flygd" });
    const green = await seedAccount(ctx.db, { tier: "green" });
    const blue = await seedAccount(ctx.db, { tier: "blue", tierLocked: true });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: flygd.id, main: true });
    await seedCharacter(ctx.db, cfg, { id: 2, accountId: flygd.id }); // alt counts too
    await seedCharacter(ctx.db, cfg, { id: 3, accountId: green.id });
    await seedCharacter(ctx.db, cfg, { id: 4, accountId: blue.id });
    const rows = await getFlygdCharacters(ctx.db);
    expect(rows.map((r) => r.characterId).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(rows[0]).toMatchObject({ accountId: flygd.id, tokenStatus: "valid" });
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/contacts-diff.test.ts tests/desired.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`src/core/contacts-diff.ts`:

```ts
export type ContactState = {
  contactId: number;
  standing: number;
  labelIds: number[];
};

export type ContactsDiff = {
  add: number[];
  update: Array<{ contactId: number; labelIds: number[] }>;
  remove: number[];
};

/**
 * Label-ownership policy (accepted-destructive, aa-standingssync precedent):
 * the app owns `labelId` outright. Desired ids are added, or taken over if
 * they already exist as personal contacts (standing re-asserted, our label
 * added while PRESERVING existing labels — ESI PUT replaces label_ids
 * wholesale). Contacts carrying our label that leave the desired set are
 * deleted entirely. Contacts never carrying our label are never modified.
 * `desiredIds` must already exclude the target character itself.
 */
export function diffContacts(input: {
  desiredIds: number[];
  standing: number;
  labelId: number;
  contacts: ContactState[];
}): ContactsDiff {
  const desired = new Set(input.desiredIds);
  const byId = new Map(input.contacts.map((c) => [c.contactId, c]));
  const add: number[] = [];
  const update: Array<{ contactId: number; labelIds: number[] }> = [];
  for (const id of input.desiredIds) {
    const existing = byId.get(id);
    if (!existing) {
      add.push(id);
      continue;
    }
    const hasLabel = existing.labelIds.includes(input.labelId);
    if (!hasLabel || existing.standing !== input.standing) {
      update.push({
        contactId: id,
        labelIds: hasLabel ? existing.labelIds : [...existing.labelIds, input.labelId],
      });
    }
  }
  const remove = input.contacts
    .filter((c) => c.labelIds.includes(input.labelId) && !desired.has(c.contactId))
    .map((c) => c.contactId);
  return { add, update, remove };
}
```

`src/services/desired.ts`:

```ts
import { eq } from "drizzle-orm";
import type { Dbx } from "@/db";
import { account, character } from "@/db/schema";

export type FlygdCharacter = {
  characterId: number;
  accountId: string;
  name: string;
  refreshTokenEnc: string | null;
  tokenStatus: "valid" | "invalid" | "needs_reauth" | "missing";
  scopes: string[];
};

/**
 * The derived desired set: every character of every FlyGD account (spec: Data
 * model → Derived). Green/Blue accounts simply fall out; nothing is deleted.
 */
export async function getFlygdCharacters(dbx: Dbx): Promise<FlygdCharacter[]> {
  return dbx
    .select({
      characterId: character.id,
      accountId: character.accountId,
      name: character.name,
      refreshTokenEnc: character.refreshTokenEnc,
      tokenStatus: character.tokenStatus,
      scopes: character.scopes,
    })
    .from(character)
    .innerJoin(account, eq(character.accountId, account.id))
    .where(eq(account.tier, "flygd"));
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- tests/contacts-diff.test.ts tests/desired.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/contacts-diff.ts src/services/desired.ts tests/contacts-diff.test.ts tests/desired.test.ts
git commit -m "feat: desired-set query and label-scoped contacts diff"
```

---

### Task 8: Contact push job

**Files:**
- Create: `src/jobs/contacts.ts`
- Test: `tests/contacts-job.test.ts`

**Interfaces:**
- Consumes: `getFlygdCharacters`, `diffContacts`, `getFreshAccessToken`, `EsiClient` (contact methods), `runJob`, `contactSyncState` table.
- Produces:
  - `const CONTACT_SCOPES = ["esi-characters.read_contacts.v1", "esi-characters.write_contacts.v1"]`
  - `canPushContacts(ch: Pick<FlygdCharacter, "tokenStatus" | "scopes" | "refreshTokenEnc">): boolean` — per-job scope gate: token present, status not invalid/missing, and BOTH contact scopes granted. `needs_reauth` (missing some unrelated scope) is NOT a blocker.
  - `type ContactsEsi = Pick<EsiClient, "getContactLabels" | "getAllContacts" | "addContacts" | "editContacts" | "deleteContacts">`
  - `runContactsJob(deps: { db: Db; cfg: Config; esi: ContactsEsi; fetchImpl?: typeof fetch }): Promise<JobResult>` — job type `"contacts"`, global reconciliation over all push targets. Per character: labels first (missing configured label → record `missing_label`, skip ALL writes); read ALL contact pages before any destructive diff (any failure aborts that character); apply diff (updates grouped by preserved label set); record `contact_sync_state.last_result` for EVERY character in the desired set — including non-pushable ones (`token_invalid` for dead/absent tokens, `missing_scope` when the contact scopes aren't granted): `ok` / `missing_label` / `token_invalid` / `missing_scope` / `token_refresh_failed` / `needs_reauth` / `sync_failed`; `last_synced_at` only on `ok`. A 403-scope `EsiError` (`kind === "needs_reauth"`) also sets the character's `token_status` to `needs_reauth`. Transient failures → `partial` + retry; per-character permanent failures → `partial` without retry; all clean → `ok`.

- [ ] **Step 1: Write failing test**

`tests/contacts-job.test.ts`:

```ts
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { character, contactSyncState } from "@/db/schema";
import { canPushContacts, runContactsJob, type ContactsEsi } from "@/jobs/contacts";
import { EsiError, type EsiContact } from "@/lib/esi/client";
import { JobRetryError } from "@/services/sync-run";
import { setupTestDb } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";

const cfg = testConfig(); // label "flygd", standing 5
const LABEL_ID = 77;

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(async () => {
  await ctx.db.execute(sql`
    TRUNCATE account, "character", discord_link, session, bootstrap_admin_grant,
      outbox, oauth_transaction, contact_sync_state, sync_run,
      wanderer_acl_observation, audit_log RESTART IDENTITY CASCADE
  `);
});

const okToken = (async () =>
  new Response(
    JSON.stringify({ access_token: "at", refresh_token: "rt2" }),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as typeof fetch;

type Calls = {
  adds: Array<{ characterId: number; ids: number[]; labelIds: number[] }>;
  edits: Array<{ characterId: number; ids: number[]; labelIds: number[] }>;
  deletes: Array<{ characterId: number; ids: number[] }>;
};

/** Fake ESI: per-character labels and contacts; records all writes. */
function fakeEsi(perChar: {
  labels?: Record<number, Array<{ labelId: number; labelName: string }>>;
  contacts?: Record<number, EsiContact[] | "fail">;
}): { esi: ContactsEsi; calls: Calls } {
  const calls: Calls = { adds: [], edits: [], deletes: [] };
  const esi: ContactsEsi = {
    getContactLabels: async (characterId) =>
      perChar.labels?.[characterId] ?? [{ labelId: LABEL_ID, labelName: "flygd" }],
    getAllContacts: async (characterId) => {
      const c = perChar.contacts?.[characterId] ?? [];
      if (c === "fail") throw new EsiError("page read failed", 500, "transient");
      return c;
    },
    addContacts: async (characterId, _at, ids, _standing, labelIds) => {
      calls.adds.push({ characterId, ids, labelIds });
    },
    editContacts: async (characterId, _at, ids, _standing, labelIds) => {
      calls.edits.push({ characterId, ids, labelIds });
    },
    deleteContacts: async (characterId, _at, ids) => {
      calls.deletes.push({ characterId, ids });
    },
  };
  return { esi, calls };
}

async function lastResult(characterId: number) {
  const rows = await ctx.db
    .select()
    .from(contactSyncState)
    .where(eq(contactSyncState.characterId, characterId));
  return rows[0];
}

const labeled = (contactId: number, standing = 5): EsiContact => ({
  contactId,
  contactType: "character",
  standing,
  labelIds: [LABEL_ID],
});

describe("canPushContacts", () => {
  const base = {
    refreshTokenEnc: "enc",
    tokenStatus: "valid" as const,
    scopes: [...cfg.eveSso.scopes],
  };
  it("gates on token presence, status, and BOTH contact scopes", () => {
    expect(canPushContacts(base)).toBe(true);
    expect(canPushContacts({ ...base, refreshTokenEnc: null })).toBe(false);
    expect(canPushContacts({ ...base, tokenStatus: "invalid" })).toBe(false);
    expect(canPushContacts({ ...base, tokenStatus: "missing" })).toBe(false);
    expect(
      canPushContacts({ ...base, scopes: ["esi-characters.read_contacts.v1"] }),
    ).toBe(false);
  });
  it("needs_reauth with contact scopes granted is NOT a blocker", () => {
    expect(canPushContacts({ ...base, tokenStatus: "needs_reauth" })).toBe(true);
  });
});

describe("runContactsJob", () => {
  it("fully reconciles: add, take over, remove ours, never touch unlabeled", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
    await seedCharacter(ctx.db, cfg, { id: 2, accountId: acc.id });
    const acc2 = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, { id: 3, accountId: acc2.id, main: true });
    // Only character 1 has interesting contacts; keep the others empty.
    const { esi, calls } = fakeEsi({
      contacts: {
        1: [
          labeled(3), // desired, correct → untouched
          labeled(99), // ours, no longer desired → delete
          { contactId: 2, contactType: "character", standing: 0, labelIds: [5] }, // desired, personal → take over
          { contactId: 500, contactType: "character", standing: 10, labelIds: [] }, // unlabeled → never touched
        ],
      },
    });
    const result = await runContactsJob({ db: ctx.db, cfg, esi, fetchImpl: okToken });
    expect(result.status).toBe("ok");
    // character 1's desired set excludes itself: {2, 3}
    expect(calls.edits).toContainEqual({ characterId: 1, ids: [2], labelIds: [5, LABEL_ID] });
    expect(calls.deletes).toContainEqual({ characterId: 1, ids: [99] });
    expect(calls.adds.filter((c) => c.characterId === 1)).toEqual([]);
    // characters 2 and 3 each get the other two added
    expect(calls.adds).toContainEqual({ characterId: 2, ids: [1, 3], labelIds: [LABEL_ID] });
    expect(calls.adds).toContainEqual({ characterId: 3, ids: [1, 2], labelIds: [LABEL_ID] });
    expect((await lastResult(1))?.lastResult).toBe("ok");
    expect((await lastResult(1))?.lastSyncedAt).not.toBeNull();
  });

  it("records missing_label and skips ALL writes for that character", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
    await seedCharacter(ctx.db, cfg, { id: 2, accountId: acc.id });
    const { esi, calls } = fakeEsi({
      labels: { 1: [{ labelId: 9, labelName: "other" }] },
    });
    const result = await runContactsJob({ db: ctx.db, cfg, esi, fetchImpl: okToken });
    expect(result.status).toBe("ok"); // missing_label is a recorded skip, not a failure
    expect((await lastResult(1))?.lastResult).toBe("missing_label");
    expect(calls.adds.filter((c) => c.characterId === 1)).toEqual([]);
    expect(calls.deletes.filter((c) => c.characterId === 1)).toEqual([]);
  });

  it("aborts a character on a partial contact read — no destructive writes", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
    await seedCharacter(ctx.db, cfg, { id: 2, accountId: acc.id });
    const { esi, calls } = fakeEsi({ contacts: { 1: "fail" } });
    await expect(
      runContactsJob({ db: ctx.db, cfg, esi, fetchImpl: okToken }),
    ).rejects.toBeInstanceOf(JobRetryError); // transient → retry
    expect((await lastResult(1))?.lastResult).toBe("sync_failed");
    expect(calls.deletes.filter((c) => c.characterId === 1)).toEqual([]);
    // the other character still synced (partial-failure isolation)
    expect((await lastResult(2))?.lastResult).toBe("ok");
  });

  it("skips non-pushable characters but keeps them in the desired set", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
    await seedCharacter(ctx.db, cfg, { id: 2, accountId: acc.id, tokenStatus: "invalid" });
    const { esi, calls } = fakeEsi({});
    const result = await runContactsJob({ db: ctx.db, cfg, esi, fetchImpl: okToken });
    expect(result.status).toBe("ok");
    // 2 is not pushed to…
    expect(calls.adds.filter((c) => c.characterId === 2)).toEqual([]);
    // …but 2 is still in 1's desired set
    expect(calls.adds).toContainEqual({ characterId: 1, ids: [2], labelIds: [LABEL_ID] });
    // and the skip reason is persisted for the UI
    expect((await lastResult(2))?.lastResult).toBe("token_invalid");
  });

  it("records missing_scope for targets lacking the contact scopes", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
    await seedCharacter(ctx.db, cfg, {
      id: 2,
      accountId: acc.id,
      scopes: ["esi-characters.read_contacts.v1"], // write scope missing
      tokenStatus: "needs_reauth",
    });
    const { esi } = fakeEsi({});
    await runContactsJob({ db: ctx.db, cfg, esi, fetchImpl: okToken });
    expect((await lastResult(2))?.lastResult).toBe("missing_scope");
  });

  it("needs_reauth with contact scopes still syncs (per-job gating)", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, {
      id: 1,
      accountId: acc.id,
      main: true,
      tokenStatus: "needs_reauth", // e.g. missing an unrelated new scope
    });
    await seedCharacter(ctx.db, cfg, { id: 2, accountId: acc.id });
    const { esi, calls } = fakeEsi({});
    await runContactsJob({ db: ctx.db, cfg, esi, fetchImpl: okToken });
    expect(calls.adds).toContainEqual({ characterId: 1, ids: [2], labelIds: [LABEL_ID] });
  });

  it("marks the character needs_reauth when ESI rejects the scope", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
    await seedCharacter(ctx.db, cfg, { id: 2, accountId: acc.id });
    const esi: ContactsEsi = {
      ...fakeEsi({}).esi,
      getContactLabels: async (characterId) => {
        if (characterId === 1) {
          throw new EsiError("token has no scope", 403, "needs_reauth");
        }
        return [{ labelId: LABEL_ID, labelName: "flygd" }];
      },
    };
    const result = await runContactsJob({ db: ctx.db, cfg, esi, fetchImpl: okToken });
    expect(result.status).toBe("partial");
    expect((await lastResult(1))?.lastResult).toBe("needs_reauth");
    const rows = await ctx.db.select().from(character).where(eq(character.id, 1));
    expect(rows[0].tokenStatus).toBe("needs_reauth");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test -- tests/contacts-job.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/jobs/contacts.ts`:

```ts
import { eq } from "drizzle-orm";
import type { Config } from "@/config";
import type { Db, Dbx } from "@/db";
import { character, contactSyncState } from "@/db/schema";
import { diffContacts } from "@/core/contacts-diff";
import { EsiError, type EsiClient } from "@/lib/esi/client";
import { getFlygdCharacters, type FlygdCharacter } from "@/services/desired";
import { runJob, type JobResult } from "@/services/sync-run";
import { getFreshAccessToken } from "@/services/tokens";

export const CONTACT_SCOPES = [
  "esi-characters.read_contacts.v1",
  "esi-characters.write_contacts.v1",
] as const;

/**
 * Per-job scope gate (spec: needs_reauth is a capability warning, never a
 * global blocker): a token missing some unrelated scope still pushes contacts
 * as long as BOTH contact scopes are granted and the token isn't dead.
 */
export function canPushContacts(
  ch: Pick<FlygdCharacter, "tokenStatus" | "scopes" | "refreshTokenEnc">,
): boolean {
  if (!ch.refreshTokenEnc) return false;
  if (ch.tokenStatus === "invalid" || ch.tokenStatus === "missing") return false;
  return CONTACT_SCOPES.every((s) => ch.scopes.includes(s));
}

export type ContactsEsi = Pick<
  EsiClient,
  "getContactLabels" | "getAllContacts" | "addContacts" | "editContacts" | "deleteContacts"
>;

async function recordResult(
  dbx: Dbx,
  characterId: number,
  result: string,
  synced: boolean,
): Promise<void> {
  const set = synced
    ? { lastResult: result, lastSyncedAt: new Date() }
    : { lastResult: result };
  await dbx
    .insert(contactSyncState)
    .values({ characterId, ...set })
    .onConflictDoUpdate({ target: contactSyncState.characterId, set });
}

export async function runContactsJob(deps: {
  db: Db;
  cfg: Config;
  esi: ContactsEsi;
  fetchImpl?: typeof fetch;
}): Promise<JobResult> {
  const { db, cfg, esi } = deps;
  return runJob(db, "contacts", async () => {
    const flygd = await getFlygdCharacters(db);
    const desiredAll = flygd.map((c) => c.characterId);
    const counts = { targets: 0, added: 0, updated: 0, removed: 0, skipped: 0, failed: 0 };
    let transientFailures = 0;
    const errors: string[] = [];

    for (const target of flygd) {
      if (!canPushContacts(target)) {
        counts.skipped++;
        // Persist WHY, so the member/admin pages can show remediation.
        const deadToken =
          !target.refreshTokenEnc ||
          target.tokenStatus === "invalid" ||
          target.tokenStatus === "missing";
        await recordResult(
          db,
          target.characterId,
          deadToken ? "token_invalid" : "missing_scope",
          false,
        );
        continue;
      }
      counts.targets++;
      const token = await getFreshAccessToken(
        db,
        cfg,
        {
          id: target.characterId,
          refreshTokenEnc: target.refreshTokenEnc,
          tokenStatus: target.tokenStatus,
        },
        deps.fetchImpl,
      );
      if (!token.ok) {
        if (token.reason === "transient") {
          transientFailures++;
          await recordResult(db, target.characterId, "token_refresh_failed", false);
        } else {
          counts.failed++;
          await recordResult(db, target.characterId, "token_invalid", false);
        }
        continue;
      }
      try {
        // Labels first: ESI cannot create labels, so a missing label is a
        // user-remediation state — record it and skip ALL writes (spec job 2).
        const labels = await esi.getContactLabels(target.characterId, token.accessToken);
        const label = labels.find((l) => l.labelName === cfg.standings.label);
        if (!label) {
          counts.skipped++;
          await recordResult(db, target.characterId, "missing_label", false);
          continue;
        }
        // Read ALL pages before any destructive diff; getAllContacts rejects
        // on any page failure, aborting this character's reconciliation.
        const contacts = await esi.getAllContacts(target.characterId, token.accessToken);
        const diff = diffContacts({
          desiredIds: desiredAll.filter((id) => id !== target.characterId),
          standing: cfg.standings.value,
          labelId: label.labelId,
          contacts,
        });
        if (diff.add.length > 0) {
          await esi.addContacts(
            target.characterId,
            token.accessToken,
            diff.add,
            cfg.standings.value,
            [label.labelId],
          );
        }
        // Group takeovers by their preserved label set — PUT replaces
        // label_ids wholesale, so each distinct union is its own call.
        const groups = new Map<string, { labelIds: number[]; ids: number[] }>();
        for (const u of diff.update) {
          const key = u.labelIds.join(",");
          const g = groups.get(key) ?? { labelIds: u.labelIds, ids: [] };
          g.ids.push(u.contactId);
          groups.set(key, g);
        }
        for (const g of groups.values()) {
          await esi.editContacts(
            target.characterId,
            token.accessToken,
            g.ids,
            cfg.standings.value,
            g.labelIds,
          );
        }
        if (diff.remove.length > 0) {
          await esi.deleteContacts(target.characterId, token.accessToken, diff.remove);
        }
        counts.added += diff.add.length;
        counts.updated += diff.update.length;
        counts.removed += diff.remove.length;
        await recordResult(db, target.characterId, "ok", true);
      } catch (err) {
        const needsReauth = err instanceof EsiError && err.kind === "needs_reauth";
        const transient = err instanceof EsiError ? err.kind === "transient" : true;
        if (needsReauth) {
          counts.failed++;
          await db
            .update(character)
            .set({ tokenStatus: "needs_reauth" })
            .where(eq(character.id, target.characterId));
          await recordResult(db, target.characterId, "needs_reauth", false);
        } else {
          if (transient) transientFailures++;
          else counts.failed++;
          await recordResult(db, target.characterId, "sync_failed", false);
        }
        errors.push(
          `${target.characterId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (transientFailures > 0 || counts.failed > 0) {
      return {
        status: "partial",
        errorSummary: errors.slice(0, 5).join("; ") || "token failures",
        counts,
        retry: transientFailures > 0,
      };
    }
    return { status: "ok", counts };
  });
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npm test -- tests/contacts-job.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/jobs/contacts.ts tests/contacts-job.test.ts
git commit -m "feat: per-character contact push with label ownership and abort-on-partial-read"
```

---

### Task 9: Wanderer client, ACL diff, and ACL sync job

**Files:**
- Create: `src/lib/wanderer/client.ts`, `src/core/acl-diff.ts`, `src/jobs/wanderer.ts`
- Test: `tests/wanderer-client.test.ts`, `tests/acl-diff.test.ts`, `tests/wanderer-job.test.ts`

**Interfaces:**
- Consumes: `Config["wanderer"]`, `getFlygdCharacters`, `runJob`, `wandererAclObservation` table, `logAudit`.
- Produces:
  - `class WandererError extends Error { status?: number; transient: boolean }` (429/5xx/network → transient; other HTTP → permanent).
  - `createWandererClient(cfg: Config, fetchImpl?: typeof fetch)` / `type WandererClient` — the confirmed contract (see Global Constraints):
    - `getAclMembers(): Promise<Array<{ characterId: number | null; role: string }>>` — `GET {base}/api/acls/{aclId}`, members under `data.members`. Members carrying `eve_corporation_id`/`eve_alliance_id` instead of `eve_character_id` are returned with `characterId: null` (NOT rejected as malformed). EVE ids accepted as digit-string or number.
    - `addAclMember(characterId: number): Promise<void>` — `POST {base}/api/acls/{aclId}/members` with `{ member: { eve_character_id: String(id), role: "viewer" } }`; the name is resolved server-side and never sent.
    - `removeAclMember(characterId: number): Promise<void>` — `DELETE {base}/api/acls/{aclId}/members/{characterId}` (the EVE id, not the member UUID); **404 = already not a member = idempotent success**.
  - `type AclMember = { characterId: number; role: string }`; `diffAcl(input: { desiredIds: number[]; members: AclMember[] }): { add: number[]; remove: number[] }` — **`admin`-role entries are never removed; `manager` entries are removable like anyone else.** Callers pass ONLY character entries.
  - `runWandererJob(deps: { db: Db; wanderer: WandererClient }): Promise<JobResult>` — job type `"wanderer"`. **Corporation/alliance ACL entries (`characterId: null`) are filtered out before diffing — never added, removed, or observed.** Read fails → `failed` before ANY mutation (never remove on unknown state), retry per the error's transience. After any mutation (or partial failure), **re-read the ACL and persist THAT read's character entries** wholesale into `wanderer_acl_observation`; when nothing was mutated, persist the initial read. If the post-mutation re-read fails, the observation is left untouched (stale-but-honest). **Classification is preserved end-to-end:** `retry` is set only when at least one failure (mutation or re-read) was transient — all-permanent failures finish `partial` WITHOUT retry. Audits `wanderer.added` / `wanderer.removed` per successful mutation.

- [ ] **Step 1: Write failing tests**

`tests/acl-diff.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { diffAcl } from "@/core/acl-diff";

describe("diffAcl", () => {
  it("adds missing desired members and removes undesired ones", () => {
    expect(
      diffAcl({
        desiredIds: [1, 2],
        members: [
          { characterId: 2, role: "member" },
          { characterId: 3, role: "member" },
        ],
      }),
    ).toEqual({ add: [1], remove: [3] });
  });

  it("NEVER removes admin-role entries; managers are removable", () => {
    expect(
      diffAcl({
        desiredIds: [],
        members: [
          { characterId: 1, role: "admin" },
          { characterId: 2, role: "manager" },
          { characterId: 3, role: "member" },
        ],
      }),
    ).toEqual({ add: [], remove: [2, 3] });
  });

  it("is a no-op when converged", () => {
    expect(
      diffAcl({ desiredIds: [1], members: [{ characterId: 1, role: "member" }] }),
    ).toEqual({ add: [], remove: [] });
  });
});
```

`tests/wanderer-client.test.ts`:

```ts
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createWandererClient, WandererError } from "@/lib/wanderer/client";
import { testConfig } from "./helpers/config";

const cfg = testConfig(); // base https://wanderer.example, aclId acl-1
const ACL = "https://wanderer.example/api/acls/acl-1";
const MEMBERS = `${ACL}/members`;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const aclResponse = (members: unknown[]) =>
  HttpResponse.json({
    data: { id: "uuid", name: "My ACL", members },
  });

describe("createWandererClient", () => {
  it("reads the ACL with bearer auth; corp/alliance members become characterId null", async () => {
    server.use(
      http.get(ACL, ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer wkey");
        return aclResponse([
          { id: "m1", name: "Pilot A", eve_character_id: "90000001", role: "admin" },
          { id: "m2", name: "Pilot B", eve_character_id: "90000002", role: "viewer" },
          { id: "m3", name: "Some Corp", eve_corporation_id: "98000001", role: "viewer" },
          { id: "m4", name: "Some Alliance", eve_alliance_id: "99000009", role: "blocked" },
        ]);
      }),
    );
    const w = createWandererClient(cfg);
    expect(await w.getAclMembers()).toEqual([
      { characterId: 90000001, role: "admin" },
      { characterId: 90000002, role: "viewer" },
      { characterId: null, role: "viewer" },
      { characterId: null, role: "blocked" },
    ]);
  });

  it("fails closed on malformed member payloads", async () => {
    server.use(
      http.get(ACL, () =>
        aclResponse([{ eve_character_id: "not-digits", role: "x" }]),
      ),
    );
    await expect(createWandererClient(cfg).getAclMembers()).rejects.toThrow();
  });

  it("classifies 5xx as transient and 403 as permanent", async () => {
    server.use(http.get(ACL, () => HttpResponse.json({}, { status: 502 })));
    let err = await createWandererClient(cfg).getAclMembers().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WandererError);
    expect((err as WandererError).transient).toBe(true);

    server.use(http.get(ACL, () => HttpResponse.json({}, { status: 403 })));
    err = await createWandererClient(cfg).getAclMembers().catch((e: unknown) => e);
    expect((err as WandererError).transient).toBe(false);
  });

  it("adds members as viewer without a name, and deletes by EVE id", async () => {
    const posts: unknown[] = [];
    let deleted = "";
    server.use(
      http.post(MEMBERS, async ({ request }) => {
        posts.push(await request.json());
        return HttpResponse.json({
          data: { id: "uuid", name: "Resolved Server-Side", role: "viewer", eve_character_id: "90000003" },
        });
      }),
      http.delete(`${MEMBERS}/:id`, ({ params }) => {
        deleted = params.id as string;
        return HttpResponse.json({ ok: true });
      }),
    );
    const w = createWandererClient(cfg);
    await w.addAclMember(90000003);
    await w.removeAclMember(90000004);
    expect(posts).toEqual([{ member: { eve_character_id: "90000003", role: "viewer" } }]);
    expect(deleted).toBe("90000004");
  });

  it("treats a 404 on delete as idempotent success", async () => {
    server.use(
      http.delete(`${MEMBERS}/:id`, () =>
        HttpResponse.json(
          { error: "Membership not found for given ACL and external id" },
          { status: 404 },
        ),
      ),
    );
    await expect(createWandererClient(cfg).removeAclMember(90000005)).resolves.toBeUndefined();
  });
});
```

`tests/wanderer-job.test.ts`:

```ts
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLog, wandererAclObservation } from "@/db/schema";
import { runWandererJob } from "@/jobs/wanderer";
import { WandererError, type WandererClient } from "@/lib/wanderer/client";
import { JobRetryError } from "@/services/sync-run";
import { setupTestDb } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";

const cfg = testConfig();

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(async () => {
  await ctx.db.execute(sql`
    TRUNCATE account, "character", discord_link, session, bootstrap_admin_grant,
      outbox, oauth_transaction, contact_sync_state, sync_run,
      wanderer_acl_observation, audit_log RESTART IDENTITY CASCADE
  `);
});

type Member = { characterId: number | null; role: string };

/** Fake Wanderer with a mutable member list and scriptable failures. */
function fakeWanderer(initial: Member[], opts: {
  failFirstRead?: boolean;
  failReRead?: boolean;
  failRemoveOf?: number;
  /** When set with failRemoveOf, the remove failure is permanent (transient: false). */
  permanentRemoveFailure?: boolean;
} = {}) {
  let members = [...initial];
  let reads = 0;
  const client: WandererClient = {
    getAclMembers: async () => {
      reads++;
      if (opts.failFirstRead && reads === 1) {
        throw new WandererError("read failed", { status: 502, transient: true });
      }
      if (opts.failReRead && reads > 1) {
        throw new WandererError("re-read failed", { status: 502, transient: true });
      }
      return [...members];
    },
    addAclMember: async (id) => {
      members.push({ characterId: id, role: "viewer" });
    },
    removeAclMember: async (id) => {
      if (opts.failRemoveOf === id) {
        throw new WandererError("remove failed", {
          status: opts.permanentRemoveFailure ? 400 : 500,
          transient: !opts.permanentRemoveFailure,
        });
      }
      members = members.filter((m) => m.characterId !== id);
    },
  };
  return { client, members: () => members, reads: () => reads };
}

async function seedFlygdChar(id: number) {
  const acc = await seedAccount(ctx.db, { tier: "flygd" });
  await seedCharacter(ctx.db, cfg, { id, accountId: acc.id, main: true });
}

describe("runWandererJob", () => {
  it("adds desired, removes undesired (never admins), persists the POST-mutation read", async () => {
    await seedFlygdChar(1);
    const w = fakeWanderer([
      { characterId: 2, role: "member" },
      { characterId: 3, role: "admin" },
      { characterId: 4, role: "manager" },
      { characterId: null, role: "viewer" }, // corp/alliance entry — never touched
    ]);
    const result = await runWandererJob({ db: ctx.db, wanderer: w.client });
    expect(result.status).toBe("ok");
    expect(result.counts).toMatchObject({ added: 1, removed: 2 });
    expect(w.reads()).toBe(2); // initial + post-mutation
    // corp/alliance entry survived untouched…
    expect(w.members().some((m) => m.characterId === null)).toBe(true);
    // …and the observation holds only character entries
    const observed = await ctx.db.select().from(wandererAclObservation);
    expect(observed.map((o) => [o.characterId, o.role]).sort()).toEqual([
      [1, "viewer"],
      [3, "admin"],
    ]);
    const audits = await ctx.db.select().from(auditLog);
    expect(audits.filter((a) => a.action === "wanderer.removed")).toHaveLength(2);
    expect(audits.filter((a) => a.action === "wanderer.added")).toHaveLength(1);
  });

  it("aborts before ANY mutation when the initial read fails", async () => {
    await seedFlygdChar(1);
    const w = fakeWanderer([{ characterId: 2, role: "member" }], { failFirstRead: true });
    await expect(
      runWandererJob({ db: ctx.db, wanderer: w.client }),
    ).rejects.toBeInstanceOf(JobRetryError);
    expect(w.members()).toEqual([{ characterId: 2, role: "member" }]); // untouched
    expect(await ctx.db.select().from(wandererAclObservation)).toEqual([]);
  });

  it("persists the initial read as the observation when nothing needs mutating", async () => {
    await seedFlygdChar(1);
    const w = fakeWanderer([{ characterId: 1, role: "member" }]);
    await runWandererJob({ db: ctx.db, wanderer: w.client });
    expect(w.reads()).toBe(1);
    const observed = await ctx.db.select().from(wandererAclObservation);
    expect(observed).toHaveLength(1);
    expect(observed[0].characterId).toBe(1);
  });

  it("still re-reads and persists after a partial mutation failure, then retries", async () => {
    await seedFlygdChar(1);
    const w = fakeWanderer(
      [
        { characterId: 2, role: "member" },
        { characterId: 5, role: "member" },
      ],
      { failRemoveOf: 5 },
    );
    await expect(
      runWandererJob({ db: ctx.db, wanderer: w.client }),
    ).rejects.toBeInstanceOf(JobRetryError);
    const observed = await ctx.db.select().from(wandererAclObservation);
    // 5's removal failed, so the post-mutation read still contains it — and
    // the observation reflects that reality, not the desired state.
    expect(observed.map((o) => o.characterId).sort((a, b) => a - b)).toEqual([1, 5]);
  });

  it("does NOT retry when every failure was permanent", async () => {
    await seedFlygdChar(1);
    const w = fakeWanderer(
      [
        { characterId: 1, role: "viewer" },
        { characterId: 5, role: "member" },
      ],
      { failRemoveOf: 5, permanentRemoveFailure: true },
    );
    // returned, not thrown: permanent failures must not retry-loop
    const result = await runWandererJob({ db: ctx.db, wanderer: w.client });
    expect(result.status).toBe("partial");
    expect(result.retry).toBeUndefined();
  });

  it("leaves the previous observation untouched when the re-read fails", async () => {
    await seedFlygdChar(1);
    await ctx.db.insert(wandererAclObservation).values({
      characterId: 42,
      role: "member",
      observedAt: new Date(),
    });
    const w = fakeWanderer([{ characterId: 2, role: "member" }], { failReRead: true });
    await expect(
      runWandererJob({ db: ctx.db, wanderer: w.client }),
    ).rejects.toBeInstanceOf(JobRetryError);
    const observed = await ctx.db.select().from(wandererAclObservation);
    expect(observed.map((o) => o.characterId)).toEqual([42]); // stale but honest
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/acl-diff.test.ts tests/wanderer-client.test.ts tests/wanderer-job.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`src/core/acl-diff.ts`:

```ts
export type AclMember = { characterId: number; role: string };

/**
 * Spec job 3: admin-role entries are NEVER removed; manager-role entries are
 * removed like anyone else when they leave the desired set.
 */
export function diffAcl(input: { desiredIds: number[]; members: AclMember[] }): {
  add: number[];
  remove: number[];
} {
  const desired = new Set(input.desiredIds);
  const present = new Set(input.members.map((m) => m.characterId));
  return {
    add: input.desiredIds.filter((id) => !present.has(id)),
    remove: input.members
      .filter((m) => !desired.has(m.characterId) && m.role !== "admin")
      .map((m) => m.characterId),
  };
}
```

`src/lib/wanderer/client.ts`:

```ts
import { z } from "zod";
import type { Config } from "@/config";

// Wanderer ACL API — contract confirmed 2026-08-02 against wanderer source
// (access_list_api_controller.ex / access_list_member_api_controller.ex):
//   GET    /api/acls/:aclId               → { data: { ..., members: [...] } }
//   POST   /api/acls/:aclId/members       → { data: {...member} } (name resolved server-side)
//   DELETE /api/acls/:aclId/members/:id   → { ok: true }; 404 = not a member (idempotent)
// :id is the EVE character/corp/alliance id, NOT the member row's UUID. Each
// member carries exactly one of eve_character_id / eve_corporation_id /
// eve_alliance_id; non-character members surface here as characterId: null.

export class WandererError extends Error {
  status?: number;
  transient: boolean;
  constructor(message: string, opts: { status?: number; transient: boolean }) {
    super(message);
    this.status = opts.status;
    this.transient = opts.transient;
  }
}

const eveIdSchema = z.union([z.string().regex(/^\d+$/), z.number().int()]);
const aclSchema = z.object({
  data: z.object({
    members: z.array(
      z.object({
        role: z.string(),
        eve_character_id: eveIdSchema.nullish(),
        eve_corporation_id: eveIdSchema.nullish(),
        eve_alliance_id: eveIdSchema.nullish(),
      }),
    ),
  }),
});

export type WandererAclMember = { characterId: number | null; role: string };

export function createWandererClient(cfg: Config, fetchImpl: typeof fetch = fetch) {
  const base = cfg.wanderer.baseUrl.replace(/\/$/, "");
  const aclPath = `/api/acls/${cfg.wanderer.aclId}`;
  const membersPath = `${aclPath}/members`;

  async function rawRequest(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetchImpl(`${base}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${cfg.wanderer.apiKey}`,
          "content-type": "application/json",
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new WandererError(
        `wanderer request failed: ${err instanceof Error ? err.message : String(err)}`,
        { transient: true },
      );
    }
  }

  function assertOk(res: Response, method: string, path: string): Response {
    if (!res.ok) {
      throw new WandererError(`wanderer ${method} ${path} failed (${res.status})`, {
        status: res.status,
        transient: res.status === 429 || res.status >= 500,
      });
    }
    return res;
  }

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    return assertOk(await rawRequest(path, init), init.method ?? "GET", path);
  }

  return {
    async getAclMembers(): Promise<WandererAclMember[]> {
      const res = await request(aclPath);
      return aclSchema.parse(await res.json()).data.members.map((m) => ({
        characterId: m.eve_character_id != null ? Number(m.eve_character_id) : null,
        role: m.role,
      }));
    },
    async addAclMember(characterId: number): Promise<void> {
      // role "viewer" (wanderer's default); name is resolved server-side.
      await request(membersPath, {
        method: "POST",
        body: JSON.stringify({
          member: { eve_character_id: String(characterId), role: "viewer" },
        }),
      });
    },
    async removeAclMember(characterId: number): Promise<void> {
      const path = `${membersPath}/${characterId}`;
      const res = await rawRequest(path, { method: "DELETE" });
      if (res.status === 404) return; // already not a member — idempotent
      assertOk(res, "DELETE", path);
    },
  };
}

export type WandererClient = ReturnType<typeof createWandererClient>;
```

`src/jobs/wanderer.ts`:

```ts
import type { Db } from "@/db";
import { wandererAclObservation } from "@/db/schema";
import { diffAcl } from "@/core/acl-diff";
import { WandererError, type WandererClient } from "@/lib/wanderer/client";
import { logAudit } from "@/services/audit";
import { getFlygdCharacters } from "@/services/desired";
import { runJob, type JobResult } from "@/services/sync-run";

type CharacterEntry = { characterId: number; role: string };

/** The job manages ONLY character entries; corp/alliance members are inert. */
function characterEntries(
  members: Array<{ characterId: number | null; role: string }>,
): CharacterEntry[] {
  return members.flatMap((m) =>
    m.characterId !== null ? [{ characterId: m.characterId, role: m.role }] : [],
  );
}

const isTransient = (err: unknown): boolean =>
  err instanceof WandererError ? err.transient : true;

export async function runWandererJob(deps: {
  db: Db;
  wanderer: WandererClient;
}): Promise<JobResult> {
  const { db, wanderer } = deps;
  return runJob(db, "wanderer", async () => {
    const desiredIds = (await getFlygdCharacters(db)).map((c) => c.characterId);

    // Never remove on unknown state: a failed read aborts before ANY mutation.
    let members;
    try {
      members = await wanderer.getAclMembers();
    } catch (err) {
      return {
        status: "failed",
        errorSummary: `ACL read failed: ${err instanceof Error ? err.message : String(err)}`,
        ...(isTransient(err) ? { retry: true } : {}),
      };
    }

    const diff = diffAcl({ desiredIds, members: characterEntries(members) });
    const errors: string[] = [];
    let anyTransient = false;
    let added = 0;
    let removed = 0;
    for (const id of diff.add) {
      try {
        await wanderer.addAclMember(id);
        added++;
        await logAudit(db, { actor: "system", action: "wanderer.added", target: String(id) });
      } catch (err) {
        anyTransient ||= isTransient(err);
        errors.push(`add ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const id of diff.remove) {
      try {
        await wanderer.removeAclMember(id);
        removed++;
        await logAudit(db, { actor: "system", action: "wanderer.removed", target: String(id) });
      } catch (err) {
        anyTransient ||= isTransient(err);
        errors.push(`remove ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Persist the POST-mutation state (spec: the UI never shows pre-mutation
    // state). No mutation → the initial read is already the live state.
    let observed: typeof members | null = members;
    if (added + removed > 0 || errors.length > 0) {
      try {
        observed = await wanderer.getAclMembers();
      } catch (err) {
        observed = null; // keep the previous observation: stale but honest
        anyTransient ||= isTransient(err);
      }
    }
    if (observed !== null) {
      const rows = characterEntries(observed);
      const observedAt = new Date();
      await db.transaction(async (tx) => {
        await tx.delete(wandererAclObservation);
        if (rows.length > 0) {
          await tx.insert(wandererAclObservation).values(
            rows.map((m) => ({ characterId: m.characterId, role: m.role, observedAt })),
          );
        }
      });
    }

    const counts = { added, removed, addFailed: diff.add.length - added, removeFailed: diff.remove.length - removed };
    if (errors.length > 0 || observed === null) {
      return {
        status: "partial",
        errorSummary: [...errors, ...(observed === null ? ["post-mutation re-read failed"] : [])]
          .slice(0, 5)
          .join("; "),
        counts,
        // Preserve classification: only transient trouble earns a retry.
        ...(anyTransient ? { retry: true } : {}),
      };
    }
    return { status: "ok", counts };
  });
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- tests/acl-diff.test.ts tests/wanderer-client.test.ts tests/wanderer-job.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/wanderer/client.ts src/core/acl-diff.ts src/jobs/wanderer.ts tests/acl-diff.test.ts tests/wanderer-client.test.ts tests/wanderer-job.test.ts
git commit -m "feat: wanderer ACL sync with post-mutation observation"
```

---

### Task 10: Discord REST client, role logic, and role sync job

**Files:**
- Create: `src/lib/discord/rest.ts`, `src/core/role-diff.ts`, `src/jobs/discord-roles.ts`
- Test: `tests/discord-rest.test.ts`, `tests/role-diff.test.ts`, `tests/discord-roles-job.test.ts`

**Interfaces:**
- Consumes: `Config["discord"]`, `runJob`, `postOpsWebhook`, `logAudit`, `discordLink`/`account` tables.
- Produces:
  - `class DiscordApiError extends Error { status?: number; transient: boolean }` (429/5xx/network → transient).
  - `createDiscordClient(cfg: Config, fetchImpl?: typeof fetch)` / `type DiscordClient` with: `getGuildRoles(): Promise<Array<{ id: string; name: string; position: number; permissions: string }>>`, `getBotUserId(): Promise<string>`, `getGuildMember(userId: string): Promise<{ roles: string[] } | null>` (404 → null), `addMemberRole(userId, roleId): Promise<void>`, `removeMemberRole(userId, roleId): Promise<void>`. Base `https://discord.com/api/v10`, `Authorization: Bot <token>`.
  - In `src/core/role-diff.ts`:
    - `type ManagedRoleIds = { flygd: string; blue: string; green: string }`
    - `diffRoles(input: { tier: "flygd" | "blue" | "green"; managed: ManagedRoleIds; memberRoleIds: string[] }): { add: string[]; remove: string[] }` — ensure exactly the tier's role among the three managed roles; other roles untouched.
    - `stripManagedRoles(managed: ManagedRoleIds, memberRoleIds: string[]): string[]` — the managed roles the member currently has (for unlinked-user deprovision).
    - `validateRoleConfig(input: { managed: ManagedRoleIds; guildRoles: Array<{ id: string; position: number; permissions: string }>; botRoleIds: string[] }): { ok: true } | { ok: false; error: string }` — three distinct ids, all present in the guild, bot has Manage Roles (or Administrator), bot's highest role above every managed role.
  - `runDiscordRolesJob(deps: { db: Db; cfg: Config; discord: DiscordClient; fetchImpl?: typeof fetch }, opts?: { accountId?: string; discordUserId?: string }): Promise<JobResult>` — job type `"discord-roles"`. Config validation runs FIRST each run; validation failure is **permanent-config**: posts the ops webhook immediately and returns `failed` WITHOUT retry. **A permanent `DiscordApiError` (e.g. 401/403 — bad bot token, missing access) while FETCHING the config data takes the same permanent-config path**; only transient fetch errors propagate into a pg-boss retry. `opts.discordUserId` handles `{kind:"discord-user"}` outbox payloads: if the user is still unlinked, strip managed roles (not-in-guild → log and skip); if re-linked meanwhile, skip (the account path owns it). Otherwise iterate Discord-linked accounts (optionally scoped), ensuring exactly the tier's managed role; user-not-in-guild → count and skip; audits `discord.role_changed`.

- [ ] **Step 1: Write failing tests**

`tests/role-diff.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { diffRoles, stripManagedRoles, validateRoleConfig } from "@/core/role-diff";

const managed = { flygd: "10", blue: "11", green: "12" };

describe("diffRoles", () => {
  it("adds the tier role and removes the other managed roles only", () => {
    expect(
      diffRoles({ tier: "flygd", managed, memberRoleIds: ["11", "12", "999"] }),
    ).toEqual({ add: ["10"], remove: ["11", "12"] });
  });
  it("is a no-op when exactly the tier role is present", () => {
    expect(diffRoles({ tier: "green", managed, memberRoleIds: ["12", "999"] })).toEqual({
      add: [],
      remove: [],
    });
  });
});

describe("stripManagedRoles", () => {
  it("returns only the managed roles the member has", () => {
    expect(stripManagedRoles(managed, ["11", "999", "12"])).toEqual(["11", "12"]);
    expect(stripManagedRoles(managed, ["999"])).toEqual([]);
  });
});

describe("validateRoleConfig", () => {
  const MANAGE_ROLES = String(1 << 28);
  const guildRoles = [
    { id: "10", position: 5, permissions: "0" },
    { id: "11", position: 4, permissions: "0" },
    { id: "12", position: 3, permissions: "0" },
    { id: "bot-role", position: 9, permissions: MANAGE_ROLES },
  ];

  it("accepts a valid config", () => {
    expect(
      validateRoleConfig({ managed, guildRoles, botRoleIds: ["bot-role"] }),
    ).toEqual({ ok: true });
  });
  it("rejects duplicate managed role ids", () => {
    const r = validateRoleConfig({
      managed: { flygd: "10", blue: "10", green: "12" },
      guildRoles,
      botRoleIds: ["bot-role"],
    });
    expect(r).toMatchObject({ ok: false });
  });
  it("rejects managed roles missing from the guild", () => {
    const r = validateRoleConfig({
      managed: { ...managed, blue: "404" },
      guildRoles,
      botRoleIds: ["bot-role"],
    });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("404") });
  });
  it("rejects a bot without Manage Roles", () => {
    const r = validateRoleConfig({
      managed,
      guildRoles: guildRoles.map((g) =>
        g.id === "bot-role" ? { ...g, permissions: "0" } : g,
      ),
      botRoleIds: ["bot-role"],
    });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("Manage Roles") });
  });
  it("accepts Administrator in place of Manage Roles", () => {
    const r = validateRoleConfig({
      managed,
      guildRoles: guildRoles.map((g) =>
        g.id === "bot-role" ? { ...g, permissions: String(1 << 3) } : g,
      ),
      botRoleIds: ["bot-role"],
    });
    expect(r).toEqual({ ok: true });
  });
  it("rejects a bot whose highest role is not above the managed roles", () => {
    const r = validateRoleConfig({
      managed,
      guildRoles: guildRoles.map((g) =>
        g.id === "bot-role" ? { ...g, position: 4 } : g,
      ),
      botRoleIds: ["bot-role"],
    });
    expect(r).toMatchObject({ ok: false });
  });
});
```

`tests/discord-rest.test.ts`:

```ts
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDiscordClient, DiscordApiError } from "@/lib/discord/rest";
import { testConfig } from "./helpers/config";

const cfg = testConfig(); // guild 9000, bot token "bot-token"
const API = "https://discord.com/api/v10";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("createDiscordClient", () => {
  it("sends bot auth and parses guild roles", async () => {
    server.use(
      http.get(`${API}/guilds/9000/roles`, ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bot bot-token");
        return HttpResponse.json([
          { id: "10", name: "FlyGD", position: 5, permissions: "0", extra: "ignored" },
        ]);
      }),
    );
    expect(await createDiscordClient(cfg).getGuildRoles()).toEqual([
      { id: "10", name: "FlyGD", position: 5, permissions: "0" },
    ]);
  });

  it("returns null for a 404 guild member (user not in guild)", async () => {
    server.use(
      http.get(`${API}/guilds/9000/members/u1`, () =>
        HttpResponse.json({ message: "Unknown Member" }, { status: 404 }),
      ),
    );
    expect(await createDiscordClient(cfg).getGuildMember("u1")).toBeNull();
  });

  it("classifies 429 as transient", async () => {
    server.use(
      http.get(`${API}/guilds/9000/members/u1`, () =>
        HttpResponse.json({}, { status: 429 }),
      ),
    );
    const err = await createDiscordClient(cfg).getGuildMember("u1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiscordApiError);
    expect((err as DiscordApiError).transient).toBe(true);
  });

  it("adds and removes member roles via PUT/DELETE", async () => {
    const calls: string[] = [];
    server.use(
      http.put(`${API}/guilds/9000/members/u1/roles/10`, () => {
        calls.push("put");
        return new HttpResponse(null, { status: 204 });
      }),
      http.delete(`${API}/guilds/9000/members/u1/roles/11`, () => {
        calls.push("delete");
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const d = createDiscordClient(cfg);
    await d.addMemberRole("u1", "10");
    await d.removeMemberRole("u1", "11");
    expect(calls).toEqual(["put", "delete"]);
  });

  it("resolves the bot user id", async () => {
    server.use(
      http.get(`${API}/users/@me`, () => HttpResponse.json({ id: "bot-user" })),
    );
    expect(await createDiscordClient(cfg).getBotUserId()).toBe("bot-user");
  });
});
```

`tests/discord-roles-job.test.ts`:

```ts
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, syncRun } from "@/db/schema";
import { runDiscordRolesJob } from "@/jobs/discord-roles";
import { DiscordApiError, type DiscordClient } from "@/lib/discord/rest";
import { setupTestDb } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";

const cfg = testConfig(); // managed roles 10/11/12

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(async () => {
  await ctx.db.execute(sql`
    TRUNCATE account, "character", discord_link, session, bootstrap_admin_grant,
      outbox, oauth_transaction, contact_sync_state, sync_run,
      wanderer_acl_observation, audit_log RESTART IDENTITY CASCADE
  `);
});

const MANAGE_ROLES = String(1 << 28);
const validGuildRoles = [
  { id: "10", name: "FlyGD", position: 5, permissions: "0" },
  { id: "11", name: "Blue", position: 4, permissions: "0" },
  { id: "12", name: "Green", position: 3, permissions: "0" },
  { id: "bot-role", name: "Bot", position: 9, permissions: MANAGE_ROLES },
];

function fakeDiscord(members: Record<string, string[] | null>, guildRoles = validGuildRoles) {
  const added: Array<[string, string]> = [];
  const removed: Array<[string, string]> = [];
  const client: DiscordClient = {
    getGuildRoles: async () => guildRoles,
    getBotUserId: async () => "bot-user",
    getGuildMember: async (userId) => {
      if (userId === "bot-user") return { roles: ["bot-role"] };
      const roles = members[userId];
      return roles === null || roles === undefined ? null : { roles };
    },
    addMemberRole: async (userId, roleId) => {
      added.push([userId, roleId]);
    },
    removeMemberRole: async (userId, roleId) => {
      removed.push([userId, roleId]);
    },
  };
  return { client, added, removed };
}

describe("runDiscordRolesJob", () => {
  it("ensures exactly the tier's managed role, leaving other roles alone", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd", discordUserId: "u1" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
    const d = fakeDiscord({ u1: ["11", "999"] });
    const result = await runDiscordRolesJob({ db: ctx.db, cfg, discord: d.client });
    expect(result.status).toBe("ok");
    expect(d.added).toEqual([["u1", "10"]]);
    expect(d.removed).toEqual([["u1", "11"]]); // 999 untouched
    const audits = await ctx.db.select().from(auditLog);
    expect(audits.some((a) => a.action === "discord.role_changed")).toBe(true);
  });

  it("config validation failure is permanent: failed run, webhook, NO retry", async () => {
    const badRoles = validGuildRoles.filter((r) => r.id !== "11"); // blue missing
    const d = fakeDiscord({}, badRoles);
    const webhook = vi.fn(async () => new Response("", { status: 204 }));
    const result = await runDiscordRolesJob({
      db: ctx.db,
      cfg,
      discord: d.client,
      fetchImpl: webhook as unknown as typeof fetch,
    });
    expect(result.status).toBe("failed"); // returned, not thrown → no retry loop
    expect(webhook).toHaveBeenCalledOnce();
    const runs = await ctx.db.select().from(syncRun);
    expect(runs[0].status).toBe("failed");
    expect(runs[0].errorSummary).toContain("11");
  });

  it("treats a permanent config-fetch error (403) as permanent-config: no retry", async () => {
    const d = fakeDiscord({});
    const client: DiscordClient = {
      ...d.client,
      getGuildRoles: async () => {
        throw new DiscordApiError("discord GET /guilds/9000/roles failed (403)", {
          status: 403,
          transient: false,
        });
      },
    };
    const webhook = vi.fn(async () => new Response("", { status: 204 }));
    // returned, not thrown: a bad bot token must not retry-loop
    const result = await runDiscordRolesJob({
      db: ctx.db,
      cfg,
      discord: client,
      fetchImpl: webhook as unknown as typeof fetch,
    });
    expect(result.status).toBe("failed");
    expect(webhook).toHaveBeenCalledOnce();
  });

  it("still retries transient config-fetch errors", async () => {
    const d = fakeDiscord({});
    const client: DiscordClient = {
      ...d.client,
      getGuildRoles: async () => {
        throw new DiscordApiError("discord GET /guilds/9000/roles failed (503)", {
          status: 503,
          transient: true,
        });
      },
    };
    await expect(
      runDiscordRolesJob({ db: ctx.db, cfg, discord: client }),
    ).rejects.toThrow(/503/); // thrown → pg-boss retries
  });

  it("logs and skips users not in the guild", async () => {
    const acc = await seedAccount(ctx.db, { tier: "green", discordUserId: "gone" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
    const d = fakeDiscord({ gone: null });
    const result = await runDiscordRolesJob({ db: ctx.db, cfg, discord: d.client });
    expect(result.status).toBe("ok");
    expect(result.counts).toMatchObject({ notInGuild: 1 });
    expect(d.added).toEqual([]);
  });

  it("strips managed roles from an unlinked discord user ({kind:'discord-user'})", async () => {
    const d = fakeDiscord({ u9: ["10", "12", "999"] });
    const result = await runDiscordRolesJob(
      { db: ctx.db, cfg, discord: d.client },
      { discordUserId: "u9" },
    );
    expect(result.status).toBe("ok");
    expect(d.removed.sort()).toEqual([
      ["u9", "10"],
      ["u9", "12"],
    ]);
    expect(d.added).toEqual([]);
  });

  it("skips the strip when the user re-linked meanwhile", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd", discordUserId: "u9" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
    const d = fakeDiscord({ u9: ["10"] });
    const result = await runDiscordRolesJob(
      { db: ctx.db, cfg, discord: d.client },
      { discordUserId: "u9" },
    );
    expect(result.counts).toMatchObject({ skipped: 1 });
    expect(d.removed).toEqual([]);
  });

  it("scopes to one account when accountId is passed", async () => {
    const a1 = await seedAccount(ctx.db, { tier: "flygd", discordUserId: "u1" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: a1.id, main: true });
    const a2 = await seedAccount(ctx.db, { tier: "green", discordUserId: "u2" });
    await seedCharacter(ctx.db, cfg, { id: 2, accountId: a2.id, main: true });
    const d = fakeDiscord({ u1: [], u2: [] });
    await runDiscordRolesJob(
      { db: ctx.db, cfg, discord: d.client },
      { accountId: a1.id },
    );
    expect(d.added).toEqual([["u1", "10"]]); // u2 untouched
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/role-diff.test.ts tests/discord-rest.test.ts tests/discord-roles-job.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`src/core/role-diff.ts`:

```ts
export type ManagedRoleIds = { flygd: string; blue: string; green: string };

/** Ensure exactly the tier's role among the three managed roles; all other roles untouched. */
export function diffRoles(input: {
  tier: "flygd" | "blue" | "green";
  managed: ManagedRoleIds;
  memberRoleIds: string[];
}): { add: string[]; remove: string[] } {
  const want = input.managed[input.tier];
  const managedAll = [input.managed.flygd, input.managed.blue, input.managed.green];
  const have = new Set(input.memberRoleIds);
  return {
    add: have.has(want) ? [] : [want],
    remove: managedAll.filter((r) => r !== want && have.has(r)),
  };
}

/** The managed roles a member currently carries (unlinked-user deprovision). */
export function stripManagedRoles(
  managed: ManagedRoleIds,
  memberRoleIds: string[],
): string[] {
  const managedAll = new Set([managed.flygd, managed.blue, managed.green]);
  return memberRoleIds.filter((r) => managedAll.has(r));
}

const MANAGE_ROLES = 1n << 28n;
const ADMINISTRATOR = 1n << 3n;

/**
 * Spec job 4 config validation: three distinct managed role ids that exist in
 * the guild; bot has Manage Roles (or Administrator); bot's highest role sits
 * ABOVE every managed role. Failure is permanent-config — no retry loop.
 */
export function validateRoleConfig(input: {
  managed: ManagedRoleIds;
  guildRoles: Array<{ id: string; position: number; permissions: string }>;
  botRoleIds: string[];
}): { ok: true } | { ok: false; error: string } {
  const ids = [input.managed.flygd, input.managed.blue, input.managed.green];
  if (new Set(ids).size !== 3) {
    return { ok: false, error: "managed role ids are not distinct" };
  }
  const byId = new Map(input.guildRoles.map((r) => [r.id, r]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return { ok: false, error: `managed roles missing from guild: ${missing.join(", ")}` };
  }
  const botRoles = input.botRoleIds.flatMap((id) => {
    const role = byId.get(id);
    return role ? [role] : [];
  });
  const canManage = botRoles.some(
    (r) => (BigInt(r.permissions) & (MANAGE_ROLES | ADMINISTRATOR)) !== 0n,
  );
  if (!canManage) return { ok: false, error: "bot lacks Manage Roles" };
  const botTop = botRoles.reduce((max, r) => Math.max(max, r.position), -1);
  const tooHigh = ids.filter((id) => {
    const role = byId.get(id);
    return role !== undefined && role.position >= botTop;
  });
  if (tooHigh.length > 0) {
    return {
      ok: false,
      error: `bot's highest role is not above managed roles: ${tooHigh.join(", ")}`,
    };
  }
  return { ok: true };
}
```

`src/lib/discord/rest.ts`:

```ts
import { z } from "zod";
import type { Config } from "@/config";

const API = "https://discord.com/api/v10";

export class DiscordApiError extends Error {
  status?: number;
  transient: boolean;
  constructor(message: string, opts: { status?: number; transient: boolean }) {
    super(message);
    this.status = opts.status;
    this.transient = opts.transient;
  }
}

const roleSchema = z.object({
  id: z.string(),
  name: z.string(),
  position: z.number().int(),
  permissions: z.string(),
});
const memberSchema = z.object({ roles: z.array(z.string()) });
const userSchema = z.object({ id: z.string() });

export function createDiscordClient(cfg: Config, fetchImpl: typeof fetch = fetch) {
  async function rawRequest(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetchImpl(`${API}${path}`, {
        ...init,
        headers: {
          authorization: `Bot ${cfg.discord.botToken}`,
          "content-type": "application/json",
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new DiscordApiError(
        `discord request failed: ${err instanceof Error ? err.message : String(err)}`,
        { transient: true },
      );
    }
  }

  function assertOk(res: Response, method: string, path: string): Response {
    if (!res.ok) {
      throw new DiscordApiError(`discord ${method} ${path} failed (${res.status})`, {
        status: res.status,
        transient: res.status === 429 || res.status >= 500,
      });
    }
    return res;
  }

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    return assertOk(await rawRequest(path, init), init.method ?? "GET", path);
  }

  const guild = cfg.discord.guildId;

  return {
    async getGuildRoles() {
      const res = await request(`/guilds/${guild}/roles`);
      return z.array(roleSchema).parse(await res.json());
    },
    async getBotUserId(): Promise<string> {
      const res = await request("/users/@me");
      return userSchema.parse(await res.json()).id;
    },
    /** null when the user is not in the guild (404). */
    async getGuildMember(userId: string): Promise<{ roles: string[] } | null> {
      const path = `/guilds/${guild}/members/${userId}`;
      const res = await rawRequest(path);
      if (res.status === 404) return null;
      assertOk(res, "GET", path);
      return memberSchema.parse(await res.json());
    },
    async addMemberRole(userId: string, roleId: string): Promise<void> {
      await request(`/guilds/${guild}/members/${userId}/roles/${roleId}`, {
        method: "PUT",
      });
    },
    async removeMemberRole(userId: string, roleId: string): Promise<void> {
      await request(`/guilds/${guild}/members/${userId}/roles/${roleId}`, {
        method: "DELETE",
      });
    },
  };
}

export type DiscordClient = ReturnType<typeof createDiscordClient>;
```

`src/jobs/discord-roles.ts`:

```ts
import { eq } from "drizzle-orm";
import type { Config } from "@/config";
import type { Db } from "@/db";
import { account, discordLink } from "@/db/schema";
import { diffRoles, stripManagedRoles, validateRoleConfig } from "@/core/role-diff";
import { DiscordApiError, type DiscordClient } from "@/lib/discord/rest";
import { postOpsWebhook } from "@/lib/ops-webhook";
import { logAudit } from "@/services/audit";
import { runJob, type JobResult } from "@/services/sync-run";

export async function runDiscordRolesJob(
  deps: { db: Db; cfg: Config; discord: DiscordClient; fetchImpl?: typeof fetch },
  opts: { accountId?: string; discordUserId?: string } = {},
): Promise<JobResult> {
  const { db, cfg, discord } = deps;
  return runJob(db, "discord-roles", async () => {
    // Config validation FIRST, every run. A validation failure is
    // permanent-config: alert immediately and do NOT retry-loop. The same goes
    // for PERMANENT errors fetching the config data (401/403 = bad bot token
    // or missing access); only transient fetch errors throw → pg-boss retries.
    let guildRoles;
    let botMember;
    try {
      guildRoles = await discord.getGuildRoles();
      botMember = await discord.getGuildMember(await discord.getBotUserId());
    } catch (err) {
      if (err instanceof DiscordApiError && !err.transient) {
        const msg = `discord config check failed: ${err.message}`;
        await postOpsWebhook(cfg, `authGD: ${msg}`, deps.fetchImpl);
        return { status: "failed", errorSummary: msg };
      }
      throw err;
    }
    const validation = botMember
      ? validateRoleConfig({
          managed: cfg.discord.roleIds,
          guildRoles,
          botRoleIds: botMember.roles,
        })
      : ({ ok: false, error: "bot is not a member of the configured guild" } as const);
    if (!validation.ok) {
      await postOpsWebhook(
        cfg,
        `authGD: discord role sync config invalid — ${validation.error}`,
        deps.fetchImpl,
      );
      return { status: "failed", errorSummary: validation.error };
    }

    // {kind:"discord-user"} deprovision payload: strip managed roles from a
    // user who unlinked. If they re-linked meanwhile, the account path owns it.
    if (opts.discordUserId) {
      const links = await db
        .select()
        .from(discordLink)
        .where(eq(discordLink.discordUserId, opts.discordUserId));
      if (links.length > 0) return { status: "ok", counts: { skipped: 1 } };
      const member = await discord.getGuildMember(opts.discordUserId);
      if (!member) return { status: "ok", counts: { notInGuild: 1 } };
      const remove = stripManagedRoles(cfg.discord.roleIds, member.roles);
      for (const roleId of remove) {
        await discord.removeMemberRole(opts.discordUserId, roleId);
      }
      if (remove.length > 0) {
        await logAudit(db, {
          actor: "system",
          action: "discord.role_changed",
          target: opts.discordUserId,
          details: { removed: remove, cause: "discord unlinked" },
        });
      }
      return { status: "ok", counts: { removed: remove.length } };
    }

    const rows = await db
      .select({
        accountId: account.id,
        tier: account.tier,
        discordUserId: discordLink.discordUserId,
      })
      .from(discordLink)
      .innerJoin(account, eq(discordLink.accountId, account.id))
      .where(opts.accountId ? eq(account.id, opts.accountId) : undefined);

    const counts = { changed: 0, notInGuild: 0, failed: 0 };
    let transientFailures = 0;
    const errors: string[] = [];
    for (const row of rows) {
      try {
        const member = await discord.getGuildMember(row.discordUserId);
        if (!member) {
          counts.notInGuild++; // user not in guild → log and skip
          continue;
        }
        const diff = diffRoles({
          tier: row.tier,
          managed: cfg.discord.roleIds,
          memberRoleIds: member.roles,
        });
        for (const roleId of diff.add) {
          await discord.addMemberRole(row.discordUserId, roleId);
        }
        for (const roleId of diff.remove) {
          await discord.removeMemberRole(row.discordUserId, roleId);
        }
        if (diff.add.length + diff.remove.length > 0) {
          counts.changed++;
          await logAudit(db, {
            actor: "system",
            action: "discord.role_changed",
            target: row.discordUserId,
            details: { added: diff.add, removed: diff.remove, tier: row.tier },
          });
        }
      } catch (err) {
        if (err instanceof DiscordApiError && !err.transient) counts.failed++;
        else transientFailures++;
        errors.push(
          `${row.discordUserId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (transientFailures > 0 || counts.failed > 0) {
      return {
        status: "partial",
        errorSummary: errors.slice(0, 5).join("; "),
        counts,
        retry: transientFailures > 0,
      };
    }
    return { status: "ok", counts };
  });
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- tests/role-diff.test.ts tests/discord-rest.test.ts tests/discord-roles-job.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/discord/rest.ts src/core/role-diff.ts src/jobs/discord-roles.ts tests/role-diff.test.ts tests/discord-rest.test.ts tests/discord-roles-job.test.ts
git commit -m "feat: discord role sync with permanent-config validation"
```

---

### Task 11: Token health job (+ transfer-reclaim service export)

**Files:**
- Create: `src/jobs/token-health.ts`
- Modify: `src/services/accounts.ts` (export a transfer-specific reclaim operation)
- Test: `tests/token-health-job.test.ts`

**Interfaces:**
- Consumes: `getFreshAccessToken`, `verifyEveAccessToken`/`setTestJwksOverride` (`src/lib/esi/sso.ts`), `runJob`, `logAudit`, and the internal `reclaimCharacter`/`findCharacterForUpdate` helpers in `src/services/accounts.ts`.
- Produces:
  - `reclaimTransferredCharacter(dbx: DbTx, characterId: number): Promise<{ ok: true } | { ok: false; error: "not_found" }>` exported from `src/services/accounts.ts` — transfer reclaim for background detection. **Unlike `unlinkCharacter` there is no last-character guard**: that guard exists only for ordinary unlink flows; transfer reclaim already legitimately produces zero-character accounts (spec: the account "simply stays Green until an admin deletes it"). Wraps the existing internal `reclaimCharacter` (advisory lock + row lock, delete link + contact state, audit `character.reclaimed`, no-main rule with demotion + outbox enqueue, session revocation).
  - `runTokenHealthJob(deps: { db: Db; cfg: Config; fetchImpl?: typeof fetch }): Promise<JobResult>` — job type `"token-health"`. For every character with a stored token not already `invalid`:
    - Refresh via `getFreshAccessToken` (permanent-only invalidation, CAS rotation, concurrent-rotation safety live there; transient → counted, retried at job level).
    - Verify the returned access token JWT → subject character id, `ownerHash`, granted `scopes`.
    - **Subject binding (fail closed):** if the JWT's character id ≠ the row's id, the token must never vouch for this row — mark `token_status: invalid` + audit `token.subject_mismatch`, keep the link, continue.
    - **owner_hash mismatch** → ownership transfer: in ONE transaction, audit `character.owner_mismatch` then `reclaimTransferredCharacter(tx, ch.id)` — this deprovisions fully (main cleared, demotion unless locked, outbox row for jobs 2–4, sessions revoked) even when it is the account's last character.
    - Otherwise persist current `scopes` and recompute `token_status`: full coverage of `cfg.eveSso.scopes` → `valid`, shortfall → `needs_reauth` (audit `token.needs_reauth` on transition).
    - Transient refresh failures → `partial` + retry. Counts: `refreshed`, `invalid`, `needsReauth`, `unlinked`, `skipped`.

- [ ] **Step 1: Write failing test**

`tests/token-health-job.test.ts`:

```ts
import { eq, sql } from "drizzle-orm";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
} from "jose";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { account, auditLog, character, outbox, session } from "@/db/schema";
import { runTokenHealthJob } from "@/jobs/token-health";
import { setTestJwksOverride } from "@/lib/esi/sso";
import { JobRetryError } from "@/services/sync-run";
import { createSession } from "@/services/session";
import { setupTestDb } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";

const cfg = testConfig();

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
let privateKey: CryptoKey;
beforeAll(async () => {
  ctx = await setupTestDb();
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  setTestJwksOverride(
    createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), alg: "RS256" }] }),
  );
});
afterAll(() => ctx.cleanup());
afterAll(() => setTestJwksOverride(undefined));
beforeEach(async () => {
  await ctx.db.execute(sql`
    TRUNCATE account, "character", discord_link, session, bootstrap_admin_grant,
      outbox, oauth_transaction, contact_sync_state, sync_run,
      wanderer_acl_observation, audit_log RESTART IDENTITY CASCADE
  `);
});

async function signAccessToken(opts: {
  characterId: number;
  ownerHash: string;
  scopes: string[];
}): Promise<string> {
  return new SignJWT({ name: "Pilot", owner: opts.ownerHash, scp: opts.scopes })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer("https://login.eveonline.com")
    .setAudience("EVE Online")
    .setSubject(`CHARACTER:EVE:${opts.characterId}`)
    .setExpirationTime("5m")
    .sign(privateKey);
}

/** SSO token endpoint fake returning a signed access token per refresh. */
function refreshFetchFor(accessTokens: Record<string, string>): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = new URLSearchParams(init?.body as string);
    const rt = body.get("refresh_token") ?? "";
    const at = accessTokens[rt];
    if (!at) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }
    return new Response(
      JSON.stringify({ access_token: at, refresh_token: `${rt}-rotated` }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

async function getChar(id: number) {
  const rows = await ctx.db.select().from(character).where(eq(character.id, id));
  return rows[0];
}

describe("runTokenHealthJob", () => {
  it("keeps healthy tokens valid and rotates them", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, {
      id: 1, accountId: acc.id, main: true, refreshToken: "rt1", ownerHash: "oh-1",
    });
    const at = await signAccessToken({
      characterId: 1, ownerHash: "oh-1", scopes: [...cfg.eveSso.scopes],
    });
    const result = await runTokenHealthJob({
      db: ctx.db, cfg, fetchImpl: refreshFetchFor({ rt1: at }),
    });
    expect(result.status).toBe("ok");
    expect(result.counts).toMatchObject({ refreshed: 1 });
    expect((await getChar(1)).tokenStatus).toBe("valid");
  });

  it("marks scope shortfalls needs_reauth (in-place re-auth, never unlink)", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, {
      id: 1, accountId: acc.id, main: true, refreshToken: "rt1", ownerHash: "oh-1",
    });
    const at = await signAccessToken({
      characterId: 1, ownerHash: "oh-1",
      scopes: ["esi-characters.read_contacts.v1"], // write scope missing
    });
    await runTokenHealthJob({ db: ctx.db, cfg, fetchImpl: refreshFetchFor({ rt1: at }) });
    const ch = await getChar(1);
    expect(ch.tokenStatus).toBe("needs_reauth");
    expect(ch.scopes).toEqual(["esi-characters.read_contacts.v1"]);
    const audits = await ctx.db.select().from(auditLog);
    expect(audits.some((a) => a.action === "token.needs_reauth")).toBe(true);
  });

  it("marks token invalid ONLY on permanent OAuth errors", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, {
      id: 1, accountId: acc.id, main: true, refreshToken: "revoked", ownerHash: "oh-1",
    });
    const result = await runTokenHealthJob({
      db: ctx.db, cfg, fetchImpl: refreshFetchFor({}), // every refresh → invalid_grant
    });
    expect(result.counts).toMatchObject({ invalid: 1 });
    expect((await getChar(1)).tokenStatus).toBe("invalid");
  });

  it("transient refresh failures change nothing and retry", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, {
      id: 1, accountId: acc.id, main: true, refreshToken: "rt1", ownerHash: "oh-1",
    });
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
        status: 503,
      })) as typeof fetch;
    await expect(
      runTokenHealthJob({ db: ctx.db, cfg, fetchImpl }),
    ).rejects.toBeInstanceOf(JobRetryError);
    expect((await getChar(1)).tokenStatus).toBe("valid");
  });

  it("owner_hash mismatch reclaims the character and revokes the account's sessions", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, {
      id: 1, accountId: acc.id, main: true, refreshToken: "rt1", ownerHash: "oh-old",
    });
    await seedCharacter(ctx.db, cfg, {
      id: 2, accountId: acc.id, refreshToken: null, tokenStatus: "missing",
    });
    await createSession(ctx.db, acc.id);
    const at = await signAccessToken({
      characterId: 1, ownerHash: "oh-NEW", scopes: [...cfg.eveSso.scopes],
    });
    const result = await runTokenHealthJob({
      db: ctx.db, cfg, fetchImpl: refreshFetchFor({ rt1: at }),
    });
    expect(result.counts).toMatchObject({ unlinked: 1 });
    expect(await getChar(1)).toBeUndefined(); // reclaimed
    expect(await ctx.db.select().from(session)).toEqual([]); // sessions revoked
    // no-main rule applied: main cleared, demoted, deprovision enqueued
    const [after] = await ctx.db.select().from(account);
    expect(after.mainCharacterId).toBeNull();
    expect(after.tier).toBe("green");
    const outboxRows = await ctx.db.select().from(outbox);
    expect(outboxRows.map((r) => r.payload)).toContainEqual({
      kind: "account",
      accountId: acc.id,
    });
    const audits = await ctx.db.select().from(auditLog);
    expect(audits.some((a) => a.action === "character.owner_mismatch")).toBe(true);
    expect(audits.some((a) => a.action === "character.reclaimed")).toBe(true);
  });

  it("reclaims even the LAST character — the account may legitimately end empty", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, {
      id: 1, accountId: acc.id, main: true, refreshToken: "rt1", ownerHash: "oh-old",
    });
    await createSession(ctx.db, acc.id);
    const at = await signAccessToken({
      characterId: 1, ownerHash: "oh-NEW", scopes: [...cfg.eveSso.scopes],
    });
    const result = await runTokenHealthJob({
      db: ctx.db, cfg, fetchImpl: refreshFetchFor({ rt1: at }),
    });
    expect(result.counts).toMatchObject({ unlinked: 1 });
    expect(await getChar(1)).toBeUndefined(); // gone — no last-character guard here
    const [after] = await ctx.db.select().from(account);
    expect(after.mainCharacterId).toBeNull();
    expect(after.tier).toBe("green"); // deprovisioned, not left flygd
    expect(await ctx.db.select().from(session)).toEqual([]);
  });

  it("fails closed when the token's subject is a DIFFERENT character", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, {
      id: 1, accountId: acc.id, main: true, refreshToken: "rt1", ownerHash: "oh-1",
    });
    // valid token, same owner hash, but subject character 2 — must never
    // vouch for character 1's row
    const at = await signAccessToken({
      characterId: 2, ownerHash: "oh-1", scopes: [...cfg.eveSso.scopes],
    });
    const result = await runTokenHealthJob({
      db: ctx.db, cfg, fetchImpl: refreshFetchFor({ rt1: at }),
    });
    expect(result.counts).toMatchObject({ invalid: 1, unlinked: 0 });
    const ch = await getChar(1);
    expect(ch).toBeDefined(); // link kept
    expect(ch.tokenStatus).toBe("invalid");
    const audits = await ctx.db.select().from(auditLog);
    expect(audits.some((a) => a.action === "token.subject_mismatch")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test -- tests/token-health-job.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

First, export the transfer-specific reclaim from `src/services/accounts.ts` — append at the end of the file (it reuses the existing internal `findCharacterForUpdate` and `reclaimCharacter` helpers; do not modify them):

```ts
/**
 * Transfer reclaim for background detection (token health): unlike
 * unlinkCharacter there is NO last-character guard — that guard exists only
 * for ordinary unlink flows, while a sold character always leaves its old
 * account, which may legitimately end with zero characters (spec: it stays
 * Green until an admin deletes it). Locks, deletes the link, applies the
 * no-main rule (demotion unless tier_locked + outbox enqueue), and revokes
 * the account's sessions.
 */
export async function reclaimTransferredCharacter(
  dbx: DbTx,
  characterId: number,
): Promise<{ ok: true } | { ok: false; error: "not_found" }> {
  const existing = await findCharacterForUpdate(dbx, characterId);
  if (!existing) return { ok: false, error: "not_found" };
  await reclaimCharacter(dbx, existing);
  return { ok: true };
}
```

`src/jobs/token-health.ts`:

```ts
import { eq } from "drizzle-orm";
import type { Config } from "@/config";
import type { Db } from "@/db";
import { character } from "@/db/schema";
import { verifyEveAccessToken } from "@/lib/esi/sso";
import { reclaimTransferredCharacter } from "@/services/accounts";
import { logAudit } from "@/services/audit";
import { runJob, type JobResult } from "@/services/sync-run";
import { getFreshAccessToken } from "@/services/tokens";

export async function runTokenHealthJob(deps: {
  db: Db;
  cfg: Config;
  fetchImpl?: typeof fetch;
}): Promise<JobResult> {
  const { db, cfg } = deps;
  return runJob(db, "token-health", async () => {
    const chars = await db.select().from(character);
    const counts = { refreshed: 0, invalid: 0, needsReauth: 0, unlinked: 0, skipped: 0 };
    let transientFailures = 0;

    for (const ch of chars) {
      if (!ch.refreshTokenEnc || ch.tokenStatus === "invalid") {
        counts.skipped++;
        continue;
      }
      const token = await getFreshAccessToken(db, cfg, ch, deps.fetchImpl);
      if (!token.ok) {
        if (token.reason === "transient") transientFailures++;
        else counts.invalid++; // permanent-only invalidation done in the service
        continue;
      }
      const identity = await verifyEveAccessToken(token.accessToken);

      if (identity.characterId !== ch.id) {
        // Fail closed: a token whose subject is another character must never
        // vouch for this row (whatever produced it — bug or tampering).
        await db.transaction(async (tx) => {
          await tx
            .update(character)
            .set({ tokenStatus: "invalid" })
            .where(eq(character.id, ch.id));
          await logAudit(tx, {
            actor: "system",
            action: "token.subject_mismatch",
            target: String(ch.id),
            details: { subjectCharacterId: identity.characterId },
          });
        });
        counts.invalid++;
        continue;
      }

      if (identity.ownerHash !== ch.ownerHash) {
        // Ownership transfer (spec: Auth flows): full reclaim — main cleared,
        // demotion unless locked, deprovision jobs enqueued, sessions revoked.
        // No last-character guard: transfer legitimately empties accounts.
        await db.transaction(async (tx) => {
          await logAudit(tx, {
            actor: "system",
            action: "character.owner_mismatch",
            target: String(ch.id),
            details: { detectedBy: "token-health" },
          });
          await reclaimTransferredCharacter(tx, ch.id);
        });
        counts.unlinked++;
        continue;
      }

      // Scope shortfall vs the CURRENT required set ⇒ needs_reauth (one-click
      // in-place re-auth in the UI); full coverage ⇒ valid.
      const covered = cfg.eveSso.scopes.every((s) => identity.scopes.includes(s));
      const nextStatus = covered ? ("valid" as const) : ("needs_reauth" as const);
      await db
        .update(character)
        .set({ scopes: identity.scopes, tokenStatus: nextStatus })
        .where(eq(character.id, ch.id));
      if (nextStatus === "needs_reauth" && ch.tokenStatus !== "needs_reauth") {
        await logAudit(db, {
          actor: "system",
          action: "token.needs_reauth",
          target: String(ch.id),
        });
        counts.needsReauth++;
      }
      counts.refreshed++;
    }

    if (transientFailures > 0) {
      return {
        status: "partial",
        errorSummary: `${transientFailures} transient refresh failures`,
        counts,
        retry: true,
      };
    }
    return { status: "ok", counts };
  });
}
```

- [ ] **Step 4: Run tests to verify pass (including the accounts suite — accounts.ts changed)**

Run: `npm test -- tests/token-health-job.test.ts tests/accounts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/jobs/token-health.ts src/services/accounts.ts tests/token-health-job.test.ts
git commit -m "feat: daily token health job with transfer reclaim and subject binding"
```

---

### Task 12: Purge job (carry-over)

**Files:**
- Create: `src/jobs/purge.ts`
- Test: `tests/purge-job.test.ts`

**Interfaces:**
- Consumes: `session`, `oauthTransaction`, `outbox` tables; `runJob`.
- Produces: `runPurgeJob(deps: { db: Db }): Promise<JobResult>` — job type `"purge"`. Deletes: expired `session` rows; consumed OR expired `oauth_transaction` rows; **dispatched** `outbox` rows older than 7 days (small scope addition beyond the carry-over so the outbox cannot grow unbounded; undispatched rows are never purged). Counts: `sessions`, `oauthTransactions`, `outbox`.

- [ ] **Step 1: Write failing test**

`tests/purge-job.test.ts`:

```ts
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { oauthTransaction, outbox, session } from "@/db/schema";
import { runPurgeJob } from "@/jobs/purge";
import { setupTestDb } from "./helpers/db";
import { seedAccount } from "./helpers/seed";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(async () => {
  await ctx.db.execute(sql`
    TRUNCATE account, "character", discord_link, session, bootstrap_admin_grant,
      outbox, oauth_transaction, contact_sync_state, sync_run,
      wanderer_acl_observation, audit_log RESTART IDENTITY CASCADE
  `);
});

const DAY = 24 * 60 * 60 * 1000;

describe("runPurgeJob", () => {
  it("purges expired sessions, spent oauth transactions, and old dispatched outbox rows", async () => {
    const acc = await seedAccount(ctx.db);
    await ctx.db.insert(session).values([
      { id: "live", accountId: acc.id, expiresAt: new Date(Date.now() + DAY) },
      { id: "expired", accountId: acc.id, expiresAt: new Date(Date.now() - DAY) },
    ]);
    await ctx.db.insert(oauthTransaction).values([
      { stateHash: "live", intent: "login", pkceVerifier: "v", expiresAt: new Date(Date.now() + DAY) },
      { stateHash: "expired", intent: "login", pkceVerifier: "v", expiresAt: new Date(Date.now() - DAY) },
      { stateHash: "consumed", intent: "login", pkceVerifier: "v", expiresAt: new Date(Date.now() + DAY), consumedAt: new Date() },
    ]);
    await ctx.db.insert(outbox).values([
      { payload: { kind: "all" } }, // undispatched → NEVER purged
      { payload: { kind: "all" }, dispatchedAt: new Date(), createdAt: new Date(Date.now() - 8 * DAY) },
      { payload: { kind: "all" }, dispatchedAt: new Date(), createdAt: new Date(Date.now() - DAY) },
    ]);

    const result = await runPurgeJob({ db: ctx.db });
    expect(result.status).toBe("ok");
    expect(result.counts).toEqual({ sessions: 1, oauthTransactions: 2, outbox: 1 });

    expect((await ctx.db.select().from(session)).map((s) => s.id)).toEqual(["live"]);
    expect((await ctx.db.select().from(oauthTransaction)).map((t) => t.stateHash)).toEqual(["live"]);
    expect(await ctx.db.select().from(outbox)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test -- tests/purge-job.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/jobs/purge.ts`:

```ts
import { and, isNotNull, lt, or } from "drizzle-orm";
import type { Db } from "@/db";
import { oauthTransaction, outbox, session } from "@/db/schema";
import { runJob, type JobResult } from "@/services/sync-run";

const OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Carry-over hygiene: expired sessions, spent OAuth transactions, and old
 * DISPATCHED outbox rows (undispatched rows are never purged). */
export async function runPurgeJob(deps: { db: Db }): Promise<JobResult> {
  const { db } = deps;
  return runJob(db, "purge", async () => {
    const now = new Date();
    const sessions = await db
      .delete(session)
      .where(lt(session.expiresAt, now))
      .returning({ id: session.id });
    const oauth = await db
      .delete(oauthTransaction)
      .where(
        or(
          isNotNull(oauthTransaction.consumedAt),
          lt(oauthTransaction.expiresAt, now),
        ),
      )
      .returning({ id: oauthTransaction.id });
    const outboxRows = await db
      .delete(outbox)
      .where(
        and(
          isNotNull(outbox.dispatchedAt),
          lt(outbox.createdAt, new Date(Date.now() - OUTBOX_RETENTION_MS)),
        ),
      )
      .returning({ id: outbox.id });
    return {
      status: "ok",
      counts: {
        sessions: sessions.length,
        oauthTransactions: oauth.length,
        outbox: outboxRows.length,
      },
    };
  });
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npm test -- tests/purge-job.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/jobs/purge.ts tests/purge-job.test.ts
git commit -m "feat: purge job for sessions, oauth transactions, and dispatched outbox rows"
```

---

### Task 13: Outbox dispatcher

**Files:**
- Create: `src/worker/queues.ts` (queue-name constants only — Task 14 extends this file), `src/worker/dispatcher.ts`
- Test: `tests/dispatcher.test.ts`

**Interfaces:**
- Consumes: `takeUndispatched`/`markDispatched`/`OutboxPayload` (`src/services/outbox.ts` — claim + mark MUST share one transaction).
- Produces:
  - In `src/worker/queues.ts`: `const QUEUES = { membership: "membership", membershipRecheck: "membership-recheck", contacts: "contacts", wanderer: "wanderer", discordRoles: "discord-roles", tokenHealth: "token-health", purge: "purge", deadLetter: "ops-dead-letter" } as const`
  - `type QueueSend = (queue: string, data: Record<string, unknown>, options: { singletonKey: string }) => Promise<unknown>`
  - `planDispatch(payload: OutboxPayload): Array<{ queue: string; data: Record<string, unknown>; singletonKey: string }>` — `{kind:"account"}` → account-scoped membership + discord-roles, global contacts + wanderer; `{kind:"discord-user"}` → discord-roles with `discordUserId`; `{kind:"all"}` → all four global. Every `data` includes `jobType` (dead-letter naming).
  - `dispatchOutbox(db: Db, send: QueueSend): Promise<number>` — claims rows and sends inside ONE transaction; a failed send rolls the claim back so rows retry next tick.
  - `startDispatcher(db: Db, send: QueueSend, intervalMs?: number): () => void` — polling loop (default 2000 ms) with an overlap guard; returns a stop function.

- [ ] **Step 1: Write failing test**

`tests/dispatcher.test.ts`:

```ts
import { isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { outbox } from "@/db/schema";
import { enqueueSync } from "@/services/outbox";
import { dispatchOutbox, planDispatch } from "@/worker/dispatcher";
import { setupTestDb } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(async () => {
  await ctx.db.execute(sql`
    TRUNCATE account, "character", discord_link, session, bootstrap_admin_grant,
      outbox, oauth_transaction, contact_sync_state, sync_run,
      wanderer_acl_observation, audit_log RESTART IDENTITY CASCADE
  `);
});

type Sent = { queue: string; data: Record<string, unknown>; singletonKey: string };
const collector = () => {
  const sent: Sent[] = [];
  const send = async (
    queue: string,
    data: Record<string, unknown>,
    options: { singletonKey: string },
  ) => {
    sent.push({ queue, data, singletonKey: options.singletonKey });
  };
  return { sent, send };
};

describe("planDispatch", () => {
  it("fans an account payload out to scoped membership/roles and GLOBAL contacts/wanderer", () => {
    const plan = planDispatch({ kind: "account", accountId: "acc-1" });
    expect(plan.map((p) => p.queue).sort()).toEqual([
      "contacts",
      "discord-roles",
      "membership",
      "wanderer",
    ]);
    const membership = plan.find((p) => p.queue === "membership");
    expect(membership?.data).toMatchObject({ accountId: "acc-1", jobType: "membership" });
    expect(membership?.singletonKey).toBe("membership:acc-1");
    // desired sets are global — contacts/wanderer coalesce on fixed keys
    expect(plan.find((p) => p.queue === "contacts")?.singletonKey).toBe("contacts:all");
    expect(plan.find((p) => p.queue === "wanderer")?.singletonKey).toBe("wanderer:all");
  });

  it("maps discord-user payloads to a role strip job", () => {
    expect(planDispatch({ kind: "discord-user", discordUserId: "u9" })).toEqual([
      {
        queue: "discord-roles",
        data: { jobType: "discord-roles", discordUserId: "u9" },
        singletonKey: "roles:user:u9",
      },
    ]);
  });

  it("maps 'all' to the four sync queues", () => {
    expect(planDispatch({ kind: "all" }).map((p) => p.queue).sort()).toEqual([
      "contacts",
      "discord-roles",
      "membership",
      "wanderer",
    ]);
  });
});

describe("dispatchOutbox", () => {
  it("sends and marks rows dispatched in one pass; second pass is a no-op", async () => {
    await enqueueSync(ctx.db, { kind: "account", accountId: "acc-1" });
    await enqueueSync(ctx.db, { kind: "discord-user", discordUserId: "u9" });
    const { sent, send } = collector();
    expect(await dispatchOutbox(ctx.db, send)).toBe(2);
    expect(sent).toHaveLength(5); // 4 fan-out + 1 role strip
    const undispatched = await ctx.db
      .select()
      .from(outbox)
      .where(isNull(outbox.dispatchedAt));
    expect(undispatched).toEqual([]);
    expect(await dispatchOutbox(ctx.db, send)).toBe(0);
    expect(sent).toHaveLength(5);
  });

  it("rolls the claim back when a send fails, so rows retry next tick", async () => {
    await enqueueSync(ctx.db, { kind: "all" });
    const failingSend = async () => {
      throw new Error("pg-boss unavailable");
    };
    await expect(dispatchOutbox(ctx.db, failingSend)).rejects.toThrow("pg-boss unavailable");
    const undispatched = await ctx.db
      .select()
      .from(outbox)
      .where(isNull(outbox.dispatchedAt));
    expect(undispatched).toHaveLength(1); // still claimable
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test -- tests/dispatcher.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`src/worker/queues.ts` (Task 14 appends `createQueues`/`scheduleJobs` to this file):

```ts
export const QUEUES = {
  membership: "membership",
  membershipRecheck: "membership-recheck",
  contacts: "contacts",
  wanderer: "wanderer",
  discordRoles: "discord-roles",
  tokenHealth: "token-health",
  purge: "purge",
  deadLetter: "ops-dead-letter",
} as const;
```

`src/worker/dispatcher.ts`:

```ts
import type { Db } from "@/db";
import {
  markDispatched,
  takeUndispatched,
  type OutboxPayload,
} from "@/services/outbox";
import { QUEUES } from "@/worker/queues";

export type QueueSend = (
  queue: string,
  data: Record<string, unknown>,
  options: { singletonKey: string },
) => Promise<unknown>;

/**
 * Maps one outbox payload to its pg-boss sends. Membership and Discord roles
 * are account-scopable; the desired contact/ACL sets are GLOBAL (every member
 * pushes every other member), so account changes fan out to global
 * reconciliations, coalesced by fixed singleton keys. Every payload carries
 * jobType so the dead-letter handler can name the failed job.
 */
export function planDispatch(
  payload: OutboxPayload,
): Array<{ queue: string; data: Record<string, unknown>; singletonKey: string }> {
  switch (payload.kind) {
    case "account":
      return [
        {
          queue: QUEUES.membership,
          data: { jobType: QUEUES.membership, accountId: payload.accountId },
          singletonKey: `membership:${payload.accountId}`,
        },
        {
          queue: QUEUES.contacts,
          data: { jobType: QUEUES.contacts },
          singletonKey: "contacts:all",
        },
        {
          queue: QUEUES.wanderer,
          data: { jobType: QUEUES.wanderer },
          singletonKey: "wanderer:all",
        },
        {
          queue: QUEUES.discordRoles,
          data: { jobType: QUEUES.discordRoles, accountId: payload.accountId },
          singletonKey: `roles:${payload.accountId}`,
        },
      ];
    case "discord-user":
      return [
        {
          queue: QUEUES.discordRoles,
          data: { jobType: QUEUES.discordRoles, discordUserId: payload.discordUserId },
          singletonKey: `roles:user:${payload.discordUserId}`,
        },
      ];
    case "all":
      return [
        {
          queue: QUEUES.membership,
          data: { jobType: QUEUES.membership },
          singletonKey: "membership:all",
        },
        {
          queue: QUEUES.contacts,
          data: { jobType: QUEUES.contacts },
          singletonKey: "contacts:all",
        },
        {
          queue: QUEUES.wanderer,
          data: { jobType: QUEUES.wanderer },
          singletonKey: "wanderer:all",
        },
        {
          queue: QUEUES.discordRoles,
          data: { jobType: QUEUES.discordRoles },
          singletonKey: "roles:all",
        },
      ];
  }
}

/**
 * Claims undispatched rows and enqueues their jobs in ONE transaction (the
 * takeUndispatched/markDispatched contract): a failed send rolls the claim
 * back so rows are re-attempted next tick. FOR UPDATE SKIP LOCKED makes
 * concurrent dispatchers safe without advisory locks.
 */
export async function dispatchOutbox(db: Db, send: QueueSend): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await takeUndispatched(tx);
    if (rows.length === 0) return 0;
    for (const row of rows) {
      for (const job of planDispatch(row.payload)) {
        await send(job.queue, job.data, { singletonKey: job.singletonKey });
      }
    }
    await markDispatched(
      tx,
      rows.map((r) => r.id),
    );
    return rows.length;
  });
}

export function startDispatcher(
  db: Db,
  send: QueueSend,
  intervalMs = 2000,
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void dispatchOutbox(db, send)
      .catch((err) => console.error("outbox dispatch failed", err))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  return () => clearInterval(timer);
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npm test -- tests/dispatcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/queues.ts src/worker/dispatcher.ts tests/dispatcher.test.ts
git commit -m "feat: transactional outbox dispatcher with singleton fan-out"
```

---

### Task 14: Worker entry — queues, schedules, workers, dead-letter alerts

**Files:**
- Modify: `src/worker/queues.ts` (add `createQueues` + `scheduleJobs`), `package.json` (add `"worker": "tsx src/worker/index.ts"` to scripts)
- Create: `src/worker/handlers.ts`, `src/worker/index.ts`
- Test: `tests/worker-queues.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 6–13; `PgBoss` from `pg-boss`.
- Produces:
  - `createQueues(boss: PgBoss): Promise<void>` — creates the dead-letter queue plus all seven job queues with `{ policy: "short", retryLimit: 5, retryDelay: 60, retryBackoff: true, deadLetter: "ops-dead-letter" }`. **`policy: "short"` is load-bearing:** pg-boss enforces singletonKey uniqueness only via the `job_i1` partial index scoped to that policy — on the default `standard` policy singletonKey coalesces nothing (see Global Constraints).
  - `type JobDeps = { db: Db; cfg: Config; esi: Pick<EsiClient, "postAffiliation"> & ContactsEsi; wanderer: WandererClient; discord: DiscordClient; fetchImpl?: typeof fetch }` and `buildJobHandlers(deps: JobDeps): Record<string, (data: unknown) => Promise<void>>` in `src/worker/handlers.ts` — one handler per job queue, each zod-parsing its payload (fail closed) and invoking the job. This is the seam Task 15 uses to drive dispatcher-emitted payloads through the REAL worker routing; `src/worker/index.ts` registers the same handlers with `boss.work`.
  - `scheduleJobs(boss: PgBoss): Promise<void>` — cron per spec: membership `*/30 * * * *`; membership-recheck (weekly `affiliation_invalid` recheck) `0 4 * * 0`; contacts `5 * * * *`; wanderer `10 * * * *`; discord-roles `15 * * * *`; token-health `0 3 * * *`; purge `30 3 * * *`. (pg-boss supports ONE schedule per queue — that's why the weekly recheck is its own queue.)
  - `src/worker/index.ts` — the worker container entrypoint: starts pg-boss on `cfg.databaseUrl`, creates queues, registers `boss.work` handlers (zod-parsing job data), registers the dead-letter handler (posts ops webhook naming `data.jobType`), applies schedules, starts the dispatcher, and shuts down cleanly on SIGTERM/SIGINT.

- [ ] **Step 1: Write failing test**

`tests/worker-queues.test.ts` (integration against the test database — pg-boss owns its own `pgboss` schema there):

```ts
import PgBoss from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUEUES, createQueues, scheduleJobs } from "@/worker/queues";

const TEST_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://authgd:authgd@localhost:5433/authgd_test";

let boss: PgBoss;
beforeAll(async () => {
  boss = new PgBoss({ connectionString: TEST_URL });
  boss.on("error", () => {});
  await boss.start();
  await createQueues(boss);
});
afterAll(async () => {
  await boss.stop({ graceful: false, wait: false });
});

describe("worker queues", () => {
  it("coalesces duplicate sends via singletonKey", async () => {
    const key = `test-${Date.now()}`; // unique per run: pg-boss state persists
    const first = await boss.send(QUEUES.contacts, { jobType: "contacts" }, { singletonKey: key });
    const second = await boss.send(QUEUES.contacts, { jobType: "contacts" }, { singletonKey: key });
    expect(first).not.toBeNull();
    expect(second).toBeNull(); // coalesced
  });

  it("applies one schedule per queue", async () => {
    await scheduleJobs(boss);
    const schedules = await boss.getSchedules();
    const byName = new Map(schedules.map((s) => [s.name, s.cron]));
    expect(byName.get(QUEUES.membership)).toBe("*/30 * * * *");
    expect(byName.get(QUEUES.membershipRecheck)).toBe("0 4 * * 0");
    expect(byName.get(QUEUES.contacts)).toBe("5 * * * *");
    expect(byName.get(QUEUES.wanderer)).toBe("10 * * * *");
    expect(byName.get(QUEUES.discordRoles)).toBe("15 * * * *");
    expect(byName.get(QUEUES.tokenHealth)).toBe("0 3 * * *");
    expect(byName.get(QUEUES.purge)).toBe("30 3 * * *");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test -- tests/worker-queues.test.ts`
Expected: FAIL (`createQueues` not exported).

- [ ] **Step 3: Implement**

Append to `src/worker/queues.ts`:

```ts
import type PgBoss from "pg-boss";

/** ~5 tries over ~30 min: 60 s base delay with exponential backoff. */
const RETRY = { retryLimit: 5, retryDelay: 60, retryBackoff: true };

const JOB_QUEUES = [
  QUEUES.membership,
  QUEUES.membershipRecheck,
  QUEUES.contacts,
  QUEUES.wanderer,
  QUEUES.discordRoles,
  QUEUES.tokenHealth,
  QUEUES.purge,
] as const;

export async function createQueues(boss: PgBoss): Promise<void> {
  await boss.createQueue(QUEUES.deadLetter);
  for (const name of JOB_QUEUES) {
    // policy "short": singletonKey uniqueness only exists under this policy
    // (pg-boss job_i1 partial index) — standard queues ignore singletonKey.
    // Final-retry failures dead-letter into ops-dead-letter → ops webhook.
    await boss.createQueue(name, {
      name,
      policy: "short",
      ...RETRY,
      deadLetter: QUEUES.deadLetter,
    });
  }
}

/**
 * Spec schedules. pg-boss allows ONE schedule per queue, which is why the
 * weekly affiliation_invalid recheck is its own queue. Hourly jobs are
 * staggered to avoid stampeding shared integrations.
 */
export async function scheduleJobs(boss: PgBoss): Promise<void> {
  await boss.schedule(QUEUES.membership, "*/30 * * * *", { jobType: QUEUES.membership });
  await boss.schedule(QUEUES.membershipRecheck, "0 4 * * 0", {
    jobType: QUEUES.membershipRecheck,
  });
  await boss.schedule(QUEUES.contacts, "5 * * * *", { jobType: QUEUES.contacts });
  await boss.schedule(QUEUES.wanderer, "10 * * * *", { jobType: QUEUES.wanderer });
  await boss.schedule(QUEUES.discordRoles, "15 * * * *", { jobType: QUEUES.discordRoles });
  await boss.schedule(QUEUES.tokenHealth, "0 3 * * *", { jobType: QUEUES.tokenHealth });
  await boss.schedule(QUEUES.purge, "30 3 * * *", { jobType: QUEUES.purge });
}
```

(If the installed pg-boss v10 typings reject `name` inside the options object, drop that property — keep the retry + deadLetter options. Do not downgrade to positional/implicit queue creation.)

`src/worker/handlers.ts` (the routing seam: `boss.work` and Task 15 both drive these):

```ts
import { z } from "zod";
import type { Config } from "@/config";
import type { Db } from "@/db";
import { runContactsJob, type ContactsEsi } from "@/jobs/contacts";
import { runDiscordRolesJob } from "@/jobs/discord-roles";
import { runMembershipJob } from "@/jobs/membership";
import { runPurgeJob } from "@/jobs/purge";
import { runTokenHealthJob } from "@/jobs/token-health";
import { runWandererJob } from "@/jobs/wanderer";
import type { DiscordClient } from "@/lib/discord/rest";
import type { EsiClient } from "@/lib/esi/client";
import type { WandererClient } from "@/lib/wanderer/client";
import { QUEUES } from "@/worker/queues";

const accountScopedSchema = z.object({ accountId: z.string().uuid().optional() });
const discordJobSchema = z.object({
  accountId: z.string().uuid().optional(),
  discordUserId: z.string().optional(),
});

export type JobDeps = {
  db: Db;
  cfg: Config;
  esi: Pick<EsiClient, "postAffiliation"> & ContactsEsi;
  wanderer: WandererClient;
  discord: DiscordClient;
  fetchImpl?: typeof fetch;
};

/**
 * One handler per job queue: parse the payload (fail closed — an unparseable
 * payload throws and the job retries into the dead-letter alert) and run the
 * job. The worker registers these with boss.work; tests drive them directly
 * with dispatcher-emitted payloads, so routing and parsing stay covered.
 */
export function buildJobHandlers(
  deps: JobDeps,
): Record<string, (data: unknown) => Promise<void>> {
  return {
    [QUEUES.membership]: async (data) => {
      const { accountId } = accountScopedSchema.parse(data);
      await runMembershipJob(deps, { accountId });
    },
    [QUEUES.membershipRecheck]: async () => {
      await runMembershipJob(deps, { recheckInvalid: true });
    },
    [QUEUES.contacts]: async () => {
      await runContactsJob(deps);
    },
    [QUEUES.wanderer]: async () => {
      await runWandererJob(deps);
    },
    [QUEUES.discordRoles]: async (data) => {
      await runDiscordRolesJob(deps, discordJobSchema.parse(data));
    },
    [QUEUES.tokenHealth]: async () => {
      await runTokenHealthJob(deps);
    },
    [QUEUES.purge]: async () => {
      await runPurgeJob(deps);
    },
  };
}
```

(The zod schemas intentionally ignore the extra `jobType` field every payload carries — zod objects strip unknown keys by default.)

`src/worker/index.ts`:

```ts
import PgBoss from "pg-boss";
import { z } from "zod";
import { getConfig } from "@/config";
import { createDb } from "@/db";
import { createDiscordClient } from "@/lib/discord/rest";
import { createEsiClient } from "@/lib/esi/client";
import { postOpsWebhook } from "@/lib/ops-webhook";
import { createWandererClient } from "@/lib/wanderer/client";
import { startDispatcher } from "@/worker/dispatcher";
import { buildJobHandlers } from "@/worker/handlers";
import { QUEUES, createQueues, scheduleJobs } from "@/worker/queues";

const deadLetterSchema = z.object({ jobType: z.string().optional() }).nullish();

async function main(): Promise<void> {
  const cfg = getConfig();
  const { db, pool } = createDb(cfg.databaseUrl);

  const boss = new PgBoss({ connectionString: cfg.databaseUrl });
  boss.on("error", (err) => console.error("pg-boss error", err));
  await boss.start();
  await createQueues(boss);

  const handlers = buildJobHandlers({
    db,
    cfg,
    esi: createEsiClient(),
    wanderer: createWandererClient(cfg),
    discord: createDiscordClient(cfg),
  });
  // pg-boss v10 handlers receive an ARRAY of jobs.
  for (const [queue, handler] of Object.entries(handlers)) {
    await boss.work(queue, async ([job]) => handler(job.data));
  }

  // Ops alerting (spec: Error handling): a job landing here exhausted its
  // retries — post to the optional Discord ops webhook.
  await boss.work(QUEUES.deadLetter, async ([job]) => {
    const data = deadLetterSchema.parse(job.data);
    await postOpsWebhook(
      cfg,
      `authGD: job \`${data?.jobType ?? "unknown"}\` failed after final retry.`,
    );
  });

  await scheduleJobs(boss);
  const stopDispatcher = startDispatcher(db, (queue, data, options) =>
    boss.send(queue, data, options),
  );

  const shutdown = async (): Promise<void> => {
    stopDispatcher();
    await boss.stop({ graceful: true, wait: true });
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  console.log("authGD worker started");
}

main().catch((err) => {
  console.error("worker failed to start", err);
  process.exit(1);
});
```

Add to `package.json` scripts (after `"start"`):

```json
    "worker": "tsx src/worker/index.ts",
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -- tests/worker-queues.test.ts && npm run typecheck`
Expected: PASS, typecheck clean. (If pg-boss typings disagree on minor option shapes — e.g. `stop()` options or `work` handler generics — adapt the worker code to the installed typings; the behaviors in the Interfaces block are the contract, not the exact option spelling.)

- [ ] **Step 5: Commit**

```bash
git add src/worker/queues.ts src/worker/handlers.ts src/worker/index.ts package.json tests/worker-queues.test.ts
git commit -m "feat: pg-boss worker entry with schedules and dead-letter ops alerts"
```

---

### Task 15: Full deprovision-path integration test and wrap-up verification

The spec's required integration case: main leaves alliance → green → contact removals + ACL removals + role change + audit rows — driven through the real outbox dispatcher AND the real worker routing: every dispatcher-emitted payload is consumed by `buildJobHandlers` (payload parsing + queue routing + job invocation), not by calling jobs manually.

**Files:**
- Test: `tests/deprovision-flow.test.ts`

**Interfaces:**
- Consumes: `dispatchOutbox`, `buildJobHandlers`/`JobDeps` (Task 14), seed helpers, fake clients (same shapes as Tasks 8–10 tests).

- [ ] **Step 1: Write the integration test**

`tests/deprovision-flow.test.ts`:

```ts
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { auditLog, wandererAclObservation } from "@/db/schema";
import type { DiscordClient } from "@/lib/discord/rest";
import type { Affiliation } from "@/lib/esi/client";
import type { WandererClient } from "@/lib/wanderer/client";
import { dispatchOutbox } from "@/worker/dispatcher";
import { buildJobHandlers, type JobDeps } from "@/worker/handlers";
import { setupTestDb } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";

const cfg = testConfig();
const LABEL_ID = 77;

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(async () => {
  await ctx.db.execute(sql`
    TRUNCATE account, "character", discord_link, session, bootstrap_admin_grant,
      outbox, oauth_transaction, contact_sync_state, sync_run,
      wanderer_acl_observation, audit_log RESTART IDENTITY CASCADE
  `);
});

const okToken = (async () =>
  new Response(
    JSON.stringify({ access_token: "at", refresh_token: "rt2" }),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as typeof fetch;

it("main leaves alliance → green → contacts removed, ACL removed, role changed, audited", async () => {
  // leaver: flygd account with main (10) + alt (11), discord-linked
  const leaver = await seedAccount(ctx.db, { tier: "flygd", discordUserId: "u-leaver" });
  await seedCharacter(ctx.db, cfg, { id: 10, accountId: leaver.id, main: true });
  await seedCharacter(ctx.db, cfg, { id: 11, accountId: leaver.id });
  // stayer: flygd account whose contacts currently include the leaver's chars
  const stayer = await seedAccount(ctx.db, { tier: "flygd", discordUserId: "u-stayer" });
  await seedCharacter(ctx.db, cfg, { id: 20, accountId: stayer.id, main: true });

  // --- fake integrations (same shapes as the Task 8–10 tests) ---
  // ESI affiliation: leaver's main left the alliance; stayer's main is still in.
  const contactWrites = { deletes: [] as number[][], adds: [] as number[][] };
  const esi: JobDeps["esi"] = {
    postAffiliation: async (ids: number[]): Promise<Affiliation[]> =>
      ids.map((id) => ({
        characterId: id,
        corporationId: 1,
        allianceId: id === 20 ? 99000001 : null,
      })),
    getContactLabels: async () => [{ labelId: LABEL_ID, labelName: "flygd" }],
    // stayer's char 20 currently has 10 and 11 under our label
    getAllContacts: async (characterId) =>
      characterId === 20
        ? [
            { contactId: 10, contactType: "character", standing: 5, labelIds: [LABEL_ID] },
            { contactId: 11, contactType: "character", standing: 5, labelIds: [LABEL_ID] },
          ]
        : [],
    addContacts: async (_c, _at, ids) => {
      contactWrites.adds.push(ids);
    },
    editContacts: async () => {},
    deleteContacts: async (_c, _at, ids) => {
      contactWrites.deletes.push(ids);
    },
  };

  // Wanderer: the ACL still lists the leaver's chars.
  let aclMembers: Array<{ characterId: number | null; role: string }> = [
    { characterId: 10, role: "viewer" },
    { characterId: 11, role: "viewer" },
    { characterId: 20, role: "viewer" },
  ];
  const wanderer: WandererClient = {
    getAclMembers: async () => [...aclMembers],
    addAclMember: async (id) => {
      aclMembers.push({ characterId: id, role: "viewer" });
    },
    removeAclMember: async (id) => {
      aclMembers = aclMembers.filter((m) => m.characterId !== id);
    },
  };

  // Discord: both users currently carry the FlyGD role.
  const MANAGE_ROLES = String(1 << 28);
  const roleOps = { added: [] as Array<[string, string]>, removed: [] as Array<[string, string]> };
  const memberRoles: Record<string, string[]> = {
    "u-leaver": ["10"],
    "u-stayer": ["10"],
    "bot-user": ["bot-role"],
  };
  const discord: DiscordClient = {
    getGuildRoles: async () => [
      { id: "10", name: "FlyGD", position: 5, permissions: "0" },
      { id: "11", name: "Blue", position: 4, permissions: "0" },
      { id: "12", name: "Green", position: 3, permissions: "0" },
      { id: "bot-role", name: "Bot", position: 9, permissions: MANAGE_ROLES },
    ],
    getBotUserId: async () => "bot-user",
    getGuildMember: async (userId) =>
      memberRoles[userId] ? { roles: memberRoles[userId] } : null,
    addMemberRole: async (userId, roleId) => {
      roleOps.added.push([userId, roleId]);
    },
    removeMemberRole: async (userId, roleId) => {
      roleOps.removed.push([userId, roleId]);
    },
  };

  // The REAL worker routing: every payload below goes through these handlers.
  const handlers = buildJobHandlers({
    db: ctx.db,
    cfg,
    esi,
    wanderer,
    discord,
    fetchImpl: okToken,
  });

  // 1) A scheduled membership run demotes the leaver (green + outbox row).
  await handlers["membership"]({ jobType: "membership" });

  // 2) The demotion's outbox row fans out through the real dispatcher…
  const sent: Array<{ queue: string; data: Record<string, unknown> }> = [];
  const dispatched = await dispatchOutbox(ctx.db, async (queue, data) => {
    sent.push({ queue, data });
  });
  expect(dispatched).toBeGreaterThanOrEqual(1);
  expect(new Set(sent.map((s) => s.queue))).toEqual(
    new Set(["membership", "contacts", "wanderer", "discord-roles"]),
  );

  // 3) …and every emitted payload is consumed by the real worker routing
  //    (payload parsing + queue → job wiring), not by manual job calls.
  for (const msg of sent) {
    const handler = handlers[msg.queue];
    expect(handler, `no handler for queue ${msg.queue}`).toBeDefined();
    await handler(msg.data);
  }

  // 4) Automatic removal (req. 3): leaver's chars deleted from 20's contacts.
  expect(contactWrites.deletes).toContainEqual([10, 11]);

  // 5) Wanderer: leaver's chars removed; observation is the post-mutation read.
  const observed = await ctx.db.select().from(wandererAclObservation);
  expect(observed.map((o) => o.characterId)).toEqual([20]);

  // 6) Discord: leaver ends with EXACTLY green; stayer untouched (the fan-out
  //    was scoped to the demoted account).
  expect(roleOps.added).toContainEqual(["u-leaver", "12"]);
  expect(roleOps.removed).toContainEqual(["u-leaver", "10"]);
  expect(roleOps.added).not.toContainEqual(["u-stayer", "12"]);

  // 7) Audit trail: demotion cause + downstream actions all recorded.
  const audits = await ctx.db.select().from(auditLog);
  const tierChange = audits.find((a) => a.action === "tier.changed");
  expect(tierChange?.details).toMatchObject({ to: "green", cause: "main left alliance" });
  expect(audits.filter((a) => a.action === "wanderer.removed")).toHaveLength(2);
  expect(audits.some((a) => a.action === "discord.role_changed")).toBe(true);
});
```

- [ ] **Step 2: Run the test**

Run: `npm test -- tests/deprovision-flow.test.ts`
Expected: PASS (everything it exercises was built in Tasks 6–14; failures here are integration bugs — fix them, do not weaken the test).

- [ ] **Step 3: Full verification**

Run: `npm test && npm run typecheck && npm run build`
Expected: all suites PASS (Plan 1's 76 tests plus everything added here), typecheck and production build clean.

- [ ] **Step 4: Commit**

```bash
git add tests/deprovision-flow.test.ts
git commit -m "test: full deprovision-path integration coverage"
```

---

## Not in this plan (Plan 3)

- Admin UI: accounts page (tier/lock controls, cryo + notes, sort/filter, Map + last-login columns), audit log page, sync status page reading `sync_run` with "sync now" buttons (which enqueue `{kind:"all"}` / account-scoped outbox rows — the dispatcher built here already handles them).
- Admin route gating for `demoteAdmin` (+ `ORDER BY account.id` on its multi-row `FOR UPDATE` — carry-over).
- Dockerfile + deploy config (web + worker containers from one image; worker start command `npm run worker`), Playwright smoke tests.
- A deploy-time smoke check of the Wanderer client against the live instance (the contract is confirmed from wanderer source, but a live read/add/remove pass at first deploy is cheap insurance).
- Login page `error` search param wiring (carry-over UI polish item).
