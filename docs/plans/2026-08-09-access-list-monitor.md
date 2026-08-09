# Access-List Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give admins a read-only page that shows, per watched in-game EVE access list, which members lack access and which non-members hold it — so they can take in-game action manually.

**Architecture:** A single designated "ACL holder" character supplies the `esi-access.read_lists.v1` token. An hourly worker job reads that character's access lists through ESI and persists a snapshot plus a row per membership entry; the admin page reads Postgres only and never touches ESI. The comparison itself is a pure function in `src/core/` that computes *effective* access — a member is covered by a character, corporation, alliance, or `allow_everyone` grant — and reports two buckets plus the broad grants that produced them.

**Tech Stack:** Next.js 15 App Router (server components + server actions), Drizzle ORM on Postgres, pg-boss via the outbox dispatcher, Zod for every ESI envelope, Vitest for unit and DB-backed tests, Playwright for e2e.

**Design spec:** `docs/specs/2026-08-09-access-list-monitor-design.md` — read it before Task 2. Every task below traces to a section of it.

## Global Constraints

- **Execution order is 2 → 12, then 1.** Task 1 is a live-ESI verification that
  needs the finished page and a real EVE token; it keeps the number 1 only so
  every "Task N" cross-reference in this plan stays valid. Start at Task 2.
- **Migrations are generated, never hand-written.** Run `npm run db:generate` after a schema edit. Never edit a migration already applied in production — `fly.toml` runs migrations as a release command on every deploy.
- **Stop and ask** before touching persisted data beyond the new tables, an already-applied migration, `TOKEN_ENCRYPTION_KEY` handling, or the OAuth state flow. These are the irreversible surfaces.
- **Cite test output.** Never claim `npm test`, `npm run typecheck`, `npm run lint`, `npm run test:e2e`, `npm run build`, `docker build .`, or `npm run format:check` passed without running it and quoting the result. Those seven are the whole CI gate, across five jobs (CONTRIBUTING.md:19-38) — `typecheck`, `lint` and `format:check` share one job, so a green typecheck proves a third of it. `format:check` is the cheap one and the one reading a diff cannot substitute for — run it per task, not only at the final gate.
- **`src/core/` is pure.** No database handle, no `fetch`, no ambient clock (CONTRIBUTING.md:55-58).
- **The web tier enqueues; the worker executes.** A server action writes an `outbox` row and returns; it never calls ESI and never dispatches to pg-boss.
- **Every state change writes an audit row** (CONTRIBUTING.md:60-63). The one deliberate exception here is "Check now", which enqueues a job and changes no state.
- **Tone discipline** (PRODUCT.md): `bad` is reserved for destructive acts. Access-list drift is `warn`, never `bad`. `Tone = "ok" | "warn" | "bad" | "off" | "neutral"` (`src/app/_components/ui.tsx:221`).
- **Never remove on unknown state** (`src/jobs/wanderer.ts:41-54`). A failed read leaves the previous entries in place; only the attempt timestamp and status change.
- **Stale-but-honest.** Every observation the page renders is shown with its age. The page never implies freshness it cannot prove.
- **`getFreshAccessToken` has exactly four outcomes** — `no_token | invalid | transient | dry_run` (`src/services/tokens.ts:17-23`). There is no `needs_reauth` arm; the service invalidates internally, so the job must not repeat the compare-and-swap.
- **Dry-run (`SYNC_MODE`) suppresses writes, not reads** — but `getFreshAccessToken` refuses in dry-run because EVE rotates refresh tokens on use, so this job cannot run against a dry-run deploy at all. That is a known limitation, not a bug.
- **The access lists are read-only.** No task in this plan may add a mutation path to ESI. The comparison deliberately avoids `add`/`remove` vocabulary for that reason.
- **Stay in scope.** Don't rename, restructure, or "clean up" files a task didn't ask about.
- **Never run two e2e suites concurrently in the same worktree** — they share one database and truncate each other, which surfaces as spurious "not signed in" / "Something broke" failures.
- **`rm` and `cp` are aliased to prompt** in this environment and exit without acting. Use `/bin/rm -f` for scratch files.

---
## Contract corrections folded in

The fragments were written against a shared interface contract. Four of that
contract's claims were wrong, and are corrected here — the tasks below already
use the corrected form:

1. **Migrations live in `drizzle/`, not `src/db/migrations/`.** `drizzle.config.ts`
   sets `out: "./drizzle"`; the existing files are `drizzle/0000_*.sql` …
   `drizzle/0011_cold_gargoyle.sql`.
2. **Every new table must also be added to `MANAGED_TABLES` in `src/db/tables.ts`.**
   `tests/seed-dev.test.ts` asserts that list matches the database, and
   `truncateAll` drives off it — omitting a table both fails that test and leaves
   rows behind between cases in Tasks 5, 6 and 7.
3. **`access_list_holder.designatedBy` and `access_list_watch.addedBy` are NOT NULL.**
   `Holder.designatedBy` is typed `string`; a nullable column makes that type a lie.
4. **`access_list_snapshot.lastAttemptAt` must not carry a bare `.defaultNow()`.**
   Both the insert and the update arms set it explicitly; a column default would
   let the failure arm's `onConflictDoUpdate` silently stop advancing it, which is
   exactly the signal the two-timestamp design exists to preserve.

One contract claim was checked and holds: `Dbx = Db | DbTx` (`src/db/index.ts:36`),
so a transaction handle is assignable and `getHolder(tx)` inside Task 7's
stale-holder guard typechecks as written.

## File Structure

**New — pure logic (no I/O, no clock):**
- `src/core/access-list-compare.ts` — effective-access comparison. One export,
  `compareAccessList`. Deliberately not `add`/`remove` shaped: the lists are
  read-only and that vocabulary would imply a mutation we cannot perform.

**New — services (database, and ESI only where named):**
- `src/services/entity-names.ts` — batched character/corp/alliance name cache
  over `esi_entity_name`. Never throws; a stale name beats no name.
- `src/services/access-lists.ts` — the holder designation, the watchlist, and
  the page's read models. Every mutation writes its audit row here, so the
  server actions stay thin.

**New — worker:**
- `src/jobs/access-lists.ts` — the job body: holder → token → scope → discovery
  → per-list read → name resolution. The only place ESI is called.

**New — page (the standard authGD page triple):**
- `src/app/admin/access-lists/view.ts` — every decision that does not need JSX,
  unit-tested: the seven-state resolver, the tone mapping, the
  does-this-row-expand predicate.
- `src/app/admin/access-lists/page.tsx` — server component, renders `view.ts`'s
  output. Reads Postgres only; never ESI.
- `src/app/admin/access-lists/actions.ts` — four server actions. Three redirect;
  `removeWatchAction` returns an `ActionOutcome` because it lives inside a
  `Disclosure` and a redirect would close the drawer.

**Modified:**
- `src/lib/esi/client.ts` — a base override, the `X-Compatibility-Date` header,
  and three read methods.
- `src/lib/esi/sso.ts`, `src/app/auth/eve/link/route.ts` — the opt-in scope grant.
- `src/db/schema.ts`, `src/db/tables.ts`, `drizzle/` — six tables, three enums.
- `src/core/schedules.ts`, `src/worker/queues.ts`, `src/worker/handlers.ts` —
  the three compile-enforced registration edits.
- `src/services/desired.ts` — `MemberCharacter` gains `corporationId` and
  `allianceId`, additively.
- `src/app/_components/nav-items.ts` — the nav entry.

The split follows the existing seam: `core` decides, `services` persist, `jobs`
call outward, the page renders. The one judgment call is putting the page's read
models in `src/services/access-lists.ts` alongside the holder and watch writes
rather than in a separate read module — they query the same five tables, and a
split would put two files in the business of knowing that schema.

---
### Task 1: Live verification against a real access list (DEFERRED — run last)

**This task is out of order on purpose. Do not execute it first.** It runs
after Task 12, once the page exists. It keeps the number 1 so every "Task 1"
reference elsewhere in this plan stays valid.

The original Task 1 was a throwaway spike script that answered four questions
against a live token before any code was written. It was dropped: three of its
four questions are already answered by CCP's published request/response
examples (recorded below as settled decisions), and the fourth has a safe
default that is *better* than whatever the spike would have found. Paying for a
tunnelled OAuth grant, `SYNC_MODE=live` on a local checkout, and a temporary
edit to the auth route bought less than it cost.

**The four questions, and how each is now settled:**

1. **Pagination.** CCP's documented response for `GET
   /characters/{id}/access-lists` is `{"access_lists":[{"id":1}]}` — an
   envelope, single page, no `X-Pages`. Task 2 parses that envelope and does
   not loop. If a live run ever returns `X-Pages`, add `getAllContacts`'s
   fail-closed loop (`src/lib/esi/client.ts:239-278`) then.
2. **The `access` value set.** Settled by design, not by observation: `access`
   stays `z.string()` regardless of what values exist, per the spec's *envelope
   closed, `access` open* rule. The documented value is `"Unspecified"`. The
   page interprets the values it recognizes and renders any other verbatim, so
   a new CCP value degrades to a bare string instead of failing the read.
3. **Base URL and compatibility date.** Settled by CCP's own curl example: the
   versionless `https://esi.evetech.net` base with `X-Compatibility-Date:
   2026-08-04`, path `/characters/{id}/access-lists` with **no** trailing
   slash. Task 2 sends the header on both endpoints.
4. **A watched list the holder cannot read.** Deliberately not relied upon.
   Task 7 skips any watched id absent from the discovery response and records
   it as `readStatus: "not_visible"` **without fetching it**. That is correct
   whether the endpoint answers 403, 404, or 200-with-empty-membership — and
   the last of those is the dangerous one, because an empty 200 is
   indistinguishable from "an admin removed everyone" and would otherwise be
   written as a real observation. Task 7 still classifies a 403/404 on a list
   discovery *did* return, so a mid-run permission change is not silently
   dropped either.

- [ ] **Step 1: Grant the scope to a real character**

With the feature built, `npm run dev`, sign in, and use the account page's
`?grant=access-lists` control that Task 8 adds — no scaffold edit is needed,
because by now the real opt-in flow exists. Pick a character that can see at
least one access list.

- [ ] **Step 2: Designate the holder and watch a list**

On `/admin/access-lists`, designate that character as the ACL holder, run
**Check now**, and confirm the catalog populates with real list names.

- [ ] **Step 3: Confirm each settled decision against what actually came back**

Check all four against the live run:

1. Discovery parsed without a schema error, and no `X-Pages` header appeared.
2. Every observed `access` value rendered — recognized ones interpreted,
   unrecognized ones verbatim, none causing a failed read.
3. Both endpoints answered 200 on the versionless base with the compatibility
   date header.
4. Watch a list id the holder cannot see (any plausible id it does not hold).
   The row must read as not visible, and the worker log must show **no** detail
   fetch for it.

- [ ] **Step 4: Record the result**

If all four hold, append a short `## Live verification (<date>)` section to
`docs/specs/2026-08-09-access-list-monitor-design.md` saying so, and commit.

If any differs — a paginated discovery response, a rejected header, a
membership shape other than the documented one — **stop and report it before
patching**. A wire format that differs from CCP's published example is a
finding about the API, not a local bug, and the fix belongs in Task 2's schemas
with a test that pins the real shape.

---

### Task 2: ESI client — base override, compatibility date, three new methods

**Files:**

- Modify: `src/lib/esi/client.ts:1-11` (constants), `:132-171` (`request`),
  `:405-451` (the returned object), plus new schemas beside `:48-67` and new
  types beside `:69-84`
- Test: `tests/esi-client.test.ts`

**Interfaces:**

- Consumes: `chunk` (`@/core/chunk`), `safeParse`, `classifyEsiError`, all
  already in the file. The wire format is settled — see Step 1.
- Produces:

```ts
export const ACCESS_LISTS_SCOPE = "esi-access.read_lists.v1";
export type EsiAccessListMember = { access: string; id: number };
export type EsiAccessList = {
  id: number;
  name: string;
  description: string;
  allowEveryone: boolean;
  characters: EsiAccessListMember[];
  corporations: EsiAccessListMember[];
  alliances: EsiAccessListMember[];
};
export type EsiEntityName = { id: number; name: string; category: string };
export type AccessListsEsi = Pick<
  EsiClient,
  "getAccessLists" | "getAccessList" | "getUniverseNames"
>;
// on the client object:
getAccessLists(characterId: number, accessToken: string): Promise<number[]>
getAccessList(characterId: number, accessListId: number, accessToken: string): Promise<EsiAccessList>
getUniverseNames(ids: number[]): Promise<EsiEntityName[]>
```

- [ ] **Step 1: Know the wire format before you write a schema**

Everything below is written against CCP's published request/response examples
for these two endpoints. Transcribe the schemas exactly; they are the part of
this task most likely to be "corrected" into something wrong by intuition.

1. **The base and the header.** Versionless `https://esi.evetech.net`, with
   `X-Compatibility-Date: 2026-08-04` on both endpoints. Path form is
   `/characters/${characterId}/access-lists` with **no** trailing slash.
2. **Discovery returns an envelope of objects, not an int array.** The response
   to `GET /characters/{id}/access-lists` is `{"access_lists":[{"id":1}]}`. The
   method still returns `Promise<number[]>` — it maps the envelope down to ids.
3. **Detail nests membership, and member keys are entity-specific.** The
   response to `GET /characters/{id}/access-lists/{listId}` puts
   `allow_everyone`, `characters`, `corporations`, and `alliances` under a
   `membership` object, and each member is keyed `character_id`,
   `corporation_id`, or `alliance_id` — never a bare `id`. The method flattens
   this into the `EsiAccessList` shape above, where every member is `{ access,
   id }`, so nothing downstream has to know the wire nesting.
4. **No pagination.** Discovery is a single page and sends no `X-Pages`, so
   `getAccessLists` does not loop. If a live run ever shows otherwise, replace
   it with `getAllContacts`'s fail-closed loop (`src/lib/esi/client.ts:239-278`)
   and add the missing-header test from `tests/esi-client.test.ts:127-148`.

Task 1 — deferred to after Task 12 — re-checks all four against a real token.

- [ ] **Step 2: Write the failing tests**

Append to `tests/esi-client.test.ts`, and add `const ROOT = "https://esi.evetech.net";`
directly under the existing `const BASE` on line 12:

```ts
describe("access lists", () => {
  it("reads list ids from the versionless base with a compatibility date", async () => {
    let seen: { url: string; auth: string | null; compat: string | null } | null = null;
    server.use(
      http.get(`${ROOT}/characters/90000001/access-lists`, ({ request }) => {
        seen = {
          url: request.url,
          auth: request.headers.get("authorization"),
          compat: request.headers.get("x-compatibility-date"),
        };
        return HttpResponse.json({ access_lists: [{ id: 101 }, { id: 202 }] });
      }),
    );
    const esi = createEsiClient();
    expect(await esi.getAccessLists(90000001, "at")).toEqual([101, 202]);
    expect(seen).toEqual({
      url: "https://esi.evetech.net/characters/90000001/access-lists",
      auth: "Bearer at",
      compat: "2026-08-04",
    });
  });

  it("flattens nested membership and defaults absent arrays to empty", async () => {
    server.use(
      http.get(`${ROOT}/characters/90000001/access-lists/101`, () =>
        HttpResponse.json({
          id: 101,
          name: "Home ACL",
          description: "the good one",
          membership: {
            allow_everyone: false,
            characters: [{ access: "member", character_id: 90000002 }],
            corporations: [{ access: "viewer", corporation_id: 98000001 }],
          },
        }),
      ),
    );
    const esi = createEsiClient();
    expect(await esi.getAccessList(90000001, 101, "at")).toEqual({
      id: 101,
      name: "Home ACL",
      description: "the good one",
      allowEveryone: false,
      characters: [{ access: "member", id: 90000002 }],
      corporations: [{ access: "viewer", id: 98000001 }],
      alliances: [],
    });
  });

  it("treats an absent membership object as an empty list, not a read failure", async () => {
    server.use(
      http.get(`${ROOT}/characters/90000001/access-lists/101`, () =>
        HttpResponse.json({ id: 101, name: "Empty ACL", description: null }),
      ),
    );
    const esi = createEsiClient();
    expect(await esi.getAccessList(90000001, 101, "at")).toEqual({
      id: 101,
      name: "Empty ACL",
      description: "",
      allowEveryone: false,
      characters: [],
      corporations: [],
      alliances: [],
    });
  });

  it("keeps an unrecognized access value verbatim rather than failing", async () => {
    server.use(
      http.get(`${ROOT}/characters/90000001/access-lists/101`, () =>
        HttpResponse.json({
          id: 101,
          name: "Home ACL",
          description: null,
          membership: {
            allow_everyone: true,
            characters: [
              { access: "some-value-ccp-added-last-tuesday", character_id: 90000002 },
            ],
            corporations: [],
            alliances: [],
          },
        }),
      ),
    );
    const esi = createEsiClient();
    const list = await esi.getAccessList(90000001, 101, "at");
    expect(list.characters[0].access).toBe("some-value-ccp-added-last-tuesday");
    expect(list.allowEveryone).toBe(true);
    expect(list.description).toBe("");
  });

  it("fails closed on a malformed list envelope", async () => {
    server.use(
      http.get(`${ROOT}/characters/90000001/access-lists/101`, () =>
        HttpResponse.json({ id: "not-a-number", name: "Home ACL" }),
      ),
    );
    const esi = createEsiClient();
    const err = await esi.getAccessList(90000001, 101, "at").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EsiError);
    expect((err as EsiError).kind).toBe("permanent");
  });

  it("throws a classified EsiError when the holder cannot see the list", async () => {
    server.use(
      http.get(`${ROOT}/characters/90000001/access-lists/101`, () =>
        HttpResponse.json({ error: "Forbidden" }, { status: 403 }),
      ),
    );
    const esi = createEsiClient();
    const err = await esi.getAccessList(90000001, 101, "at").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EsiError);
    expect((err as EsiError).status).toBe(403);
  });
});

describe("getUniverseNames", () => {
  it("posts unauthenticated and returns id, name and category", async () => {
    let auth: string | null = null;
    let body: unknown;
    server.use(
      http.post(`${BASE}/universe/names/`, async ({ request }) => {
        auth = request.headers.get("authorization");
        body = await request.json();
        return HttpResponse.json([
          { id: 90000002, name: "Some Pilot", category: "character" },
          { id: 98000001, name: "Some Corp", category: "corporation" },
        ]);
      }),
    );
    const esi = createEsiClient();
    expect(await esi.getUniverseNames([90000002, 98000001])).toEqual([
      { id: 90000002, name: "Some Pilot", category: "character" },
      { id: 98000001, name: "Some Corp", category: "corporation" },
    ]);
    expect(body).toEqual([90000002, 98000001]);
    expect(auth).toBeNull();
  });

  it("chunks ids at 1000 per request and concatenates the results", async () => {
    const sizes: number[] = [];
    server.use(
      http.post(`${BASE}/universe/names/`, async ({ request }) => {
        const ids = (await request.json()) as number[];
        sizes.push(ids.length);
        return HttpResponse.json(
          ids.map((id) => ({ id, name: `N${id}`, category: "character" })),
        );
      }),
    );
    const esi = createEsiClient();
    const ids = Array.from({ length: 1001 }, (_, i) => i + 1);
    const out = await esi.getUniverseNames(ids);
    expect(sizes).toEqual([1000, 1]);
    expect(out).toHaveLength(1001);
  });

  it("makes no request at all for an empty id list", async () => {
    // No MSW handler registered: onUnhandledRequest "error" turns any call into
    // a failure, so this asserts the early exit rather than trusting a counter.
    const esi = createEsiClient();
    expect(await esi.getUniverseNames([])).toEqual([]);
  });

  it("fails closed on a malformed names body", async () => {
    server.use(
      http.post(`${BASE}/universe/names/`, () =>
        HttpResponse.json([{ id: 1, name: 2, category: "character" }]),
      ),
    );
    const esi = createEsiClient();
    const err = await esi.getUniverseNames([1]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EsiError);
    expect((err as EsiError).kind).toBe("permanent");
  });
});
```

- [ ] **Step 3: Run the tests and watch them fail**

```bash
npx vitest run tests/esi-client.test.ts -t "access lists"
npx vitest run tests/esi-client.test.ts -t "getUniverseNames"
```

Expected: FAIL — `esi.getAccessLists is not a function` (and the same for
`getAccessList` / `getUniverseNames`), plus a TypeScript error on the same
property in the editor. Quote the real output.

- [ ] **Step 4: Add the constants, schemas and types**

In `src/lib/esi/client.ts`, extend the constant block at the top (after line 10):

```ts
const RESOLVE_IDS_CHUNK = 500; // ESI POST /universe/ids/ body limit
const NAMES_CHUNK = 1000; // ESI POST /universe/names/ body limit

/**
 * The access-list endpoints are not under the versioned `/latest` base — they
 * are served from the root and select their shape with X-Compatibility-Date
 * instead. First use of that convention in this repo; expect it to spread as
 * CCP retires `/latest`.
 */
const ESI_ROOT = "https://esi.evetech.net";
const COMPATIBILITY_DATE = "2026-08-04";
```

Beside `OPEN_WINDOW_SCOPE` (line 18), for the same reason its comment gives:

```ts
/**
 * Deliberately NOT in EVE_SSO_SCOPES: adding it there would flip every
 * character to needs_reauth at the next token-health run. Opt-in per character,
 * read back from `character.scopes`. Exported so the link route, the job's
 * scope check and the page's re-grant prompt spell it identically.
 */
export const ACCESS_LISTS_SCOPE = "esi-access.read_lists.v1";
```

Beside the other schemas (after line 67):

```ts
const accessListIdsSchema = z.object({
  access_lists: z.array(z.object({ id: z.number().int() })).nullish(),
});
// `access` fails OPEN as a plain string: a z.enum would turn CCP adding one
// value into a total read failure for a field nothing branches on. The id key
// is entity-specific on the wire — `character_id`, `corporation_id`,
// `alliance_id` — so each array gets its own schema and the client flattens
// all three to `{ access, id }`. Spelled out rather than generated: three
// literal schemas read better than one clever factory.
const characterMemberSchema = z.object({
  access: z.string(),
  character_id: z.number().int(),
});
const corporationMemberSchema = z.object({
  access: z.string(),
  corporation_id: z.number().int(),
});
const allianceMemberSchema = z.object({
  access: z.string(),
  alliance_id: z.number().int(),
});
const accessListSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string().nullish(),
  membership: z
    .object({
      allow_everyone: z.boolean().nullish(),
      characters: z.array(characterMemberSchema).nullish(),
      corporations: z.array(corporationMemberSchema).nullish(),
      alliances: z.array(allianceMemberSchema).nullish(),
    })
    .nullish(),
});
const universeNamesSchema = z.array(
  z.object({
    id: z.number().int(),
    name: z.string(),
    category: z.string(),
  }),
);
```

And beside the other exported types (after line 84):

```ts
export type EsiAccessListMember = { access: string; id: number };
export type EsiAccessList = {
  id: number;
  name: string;
  description: string;
  allowEveryone: boolean;
  characters: EsiAccessListMember[];
  corporations: EsiAccessListMember[];
  alliances: EsiAccessListMember[];
};
export type EsiEntityName = { id: number; name: string; category: string };
```

- [ ] **Step 5: Teach `request` the base override and the compatibility header**

Replace the signature and the fetch call in `request` (`:132-150`) with:

```ts
  async function request(
    path: string,
    init: RequestInit & {
      accessToken?: string;
      /** Endpoints served from the root rather than the /latest base. */
      base?: string;
      /** Send X-Compatibility-Date; the versionless endpoints need it. */
      compatibilityDate?: boolean;
    } = {},
  ): Promise<Response> {
    if (remain <= floor && resetAt > now()) {
      await sleep(resetAt - now());
      remain = Number.POSITIVE_INFINITY;
    }
    const { base, compatibilityDate, ...rest } = init;
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(init.headers as Record<string, string> | undefined),
    };
    if (init.accessToken) headers.authorization = `Bearer ${init.accessToken}`;
    if (opts.userAgent) headers["user-agent"] = opts.userAgent;
    if (compatibilityDate) headers["x-compatibility-date"] = COMPATIBILITY_DATE;
    const res = await fetchImpl(`${base ?? ESI_BASE}${path}`, {
      ...rest,
      headers,
      signal: AbortSignal.timeout(30_000),
    });
```

Everything below that line — the error-budget headers, the `!res.ok` throw, the
`return res` — is unchanged. The error message still reads `init.method`, so
failures on the new base still name their path.

- [ ] **Step 6: Add the three methods**

Insert after `getStructureName` (`:403`):

```ts
  /**
   * Ids only — each list's name costs a separate detail call, which is why the
   * job caches the catalog rather than re-reading names every run.
   */
  async function getAccessLists(
    characterId: number,
    accessToken: string,
  ): Promise<number[]> {
    const path = `/characters/${characterId}/access-lists`;
    const res = await request(path, {
      accessToken,
      base: ESI_ROOT,
      compatibilityDate: true,
    });
    const parsed = safeParse(accessListIdsSchema, await res.json(), "GET", path, res.status);
    return (parsed.access_lists ?? []).map((entry) => entry.id);
  }

  /**
   * A 403 here is a normal state, not a fault: it means the holder can no
   * longer see this list. The caller classifies it; nothing is swallowed.
   */
  async function getAccessList(
    characterId: number,
    accessListId: number,
    accessToken: string,
  ): Promise<EsiAccessList> {
    const path = `/characters/${characterId}/access-lists/${accessListId}`;
    const res = await request(path, {
      accessToken,
      base: ESI_ROOT,
      compatibilityDate: true,
    });
    const parsed = safeParse(accessListSchema, await res.json(), "GET", path, res.status);
    const m = parsed.membership;
    return {
      id: parsed.id,
      name: parsed.name,
      description: parsed.description ?? "",
      allowEveryone: m?.allow_everyone ?? false,
      characters: (m?.characters ?? []).map((c) => ({ access: c.access, id: c.character_id })),
      corporations: (m?.corporations ?? []).map((c) => ({
        access: c.access,
        id: c.corporation_id,
      })),
      alliances: (m?.alliances ?? []).map((a) => ({ access: a.access, id: a.alliance_id })),
    };
  }

  /**
   * Unauthenticated batch id→name resolve, chunked like resolveIds. Ids ESI
   * does not recognize are simply absent from the result; the caller renders
   * those bare rather than failing the run.
   */
  async function getUniverseNames(ids: number[]): Promise<EsiEntityName[]> {
    const out: EsiEntityName[] = [];
    for (const idsChunk of chunk(ids, NAMES_CHUNK)) {
      const res = await request("/universe/names/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(idsChunk),
      });
      out.push(
        ...safeParse(
          universeNamesSchema,
          await res.json(),
          "POST",
          "/universe/names/",
          res.status,
        ),
      );
    }
    return out;
  }
```

Add all three to the returned object beside `getStructureName` (`:415`):

```ts
    getStructureName,
    getAccessLists,
    getAccessList,
    getUniverseNames,
```

And add the narrow alias at the very bottom of the file, beside `EsiClient`:

```ts
export type EsiClient = ReturnType<typeof createEsiClient>;

/** The job's narrow view, per ContactsEsi: reads only, no writes reachable. */
export type AccessListsEsi = Pick<
  EsiClient,
  "getAccessLists" | "getAccessList" | "getUniverseNames"
>;
```

- [ ] **Step 7: Run the new tests and the whole client suite**

```bash
npx vitest run tests/esi-client.test.ts
```

Expected: all pass, including the pre-existing describes — the `request` change
touches every call site, so a green `contacts` / `location reads` / `resolveIds`
is the regression check for it. Quote the real output.

- [ ] **Step 8: Typecheck and format check**

```bash
npm run typecheck
npm run format:check
```

Expected: both pass. Quote the real output.

- [ ] **Step 9: Commit**

```bash
git add src/lib/esi/client.ts tests/esi-client.test.ts
git commit -m "feat(esi): read access lists from the versionless base, and batch id names"
```

---

### Task 3: Schema tables and generated migration

**Files:**

- Modify: `src/db/schema.ts:19-31` (enums), and append six tables after
  `universeName` (`:240-245`)
- Modify: `src/db/tables.ts:14-31` (`MANAGED_TABLES`)
- Create (generated, never hand-written): `drizzle/0012_*.sql` plus its
  `drizzle/meta/` entries
- Test: `tests/access-lists-schema.test.ts`

**Interfaces:**

- Consumes: `character.id` (`src/db/schema.ts:59`) for the holder FK.
- Produces, imported by Tasks 5–13:

```ts
export const accessListReadStatusEnum: PgEnum; // "ok" | "not_visible" | "failed"
export const esiEntityKindEnum: PgEnum; // "character" | "corporation" | "alliance"
export const accessListEntryKindEnum: PgEnum; // "character" | "corporation" | "alliance"
export const accessListHolder;
export const accessListCatalog;
export const accessListWatch;
export const accessListSnapshot;
export const accessListEntry;
export const esiEntityName;
```

- [ ] **Step 1: Write the failing test**

Create `tests/access-lists-schema.test.ts`. It exercises the cascade through a
real `delete(character)` rather than trusting the FK declaration, which is
exactly what the spec asks for — a `.references()` with no `onDelete` compiles
and reads fine and still breaks unlink in production.

```ts
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accessListEntry, accessListHolder, character } from "@/db/schema";
import { setupTestDb, truncateAll } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { expectCheckViolation } from "./helpers/constraints";

const cfg = testConfig();
const HOLDER_ID = 90000001;

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

async function seedHolder() {
  const acc = await seedAccount(ctx.db);
  await seedCharacter(ctx.db, cfg, { id: HOLDER_ID, accountId: acc.id, main: true });
  await ctx.db
    .insert(accessListHolder)
    .values({ id: 1, characterId: HOLDER_ID, designatedBy: acc.id });
  return acc;
}

describe("access_list_holder", () => {
  it("disappears when the holder character is deleted", async () => {
    await seedHolder();
    // The real unlink and transfer-reclaim paths both delete(character); a
    // NO ACTION default would make them fail for whoever is the holder.
    await ctx.db.delete(character).where(eq(character.id, HOLDER_ID));
    expect(await ctx.db.select().from(accessListHolder)).toEqual([]);
  });

  it("refuses a second row via the singleton check", async () => {
    const acc = await seedHolder();
    await seedCharacter(ctx.db, cfg, { id: 90000002, accountId: acc.id });
    await expectCheckViolation(
      ctx.db
        .insert(accessListHolder)
        .values({ id: 2, characterId: 90000002, designatedBy: acc.id }),
      "access_list_holder_singleton_ck",
    );
  });
});

describe("access_list_entry", () => {
  it("rejects a duplicate (list, kind, entity) triple", async () => {
    const row = {
      accessListId: 101,
      kind: "character" as const,
      entityId: 90000002,
      access: "member",
    };
    await ctx.db.insert(accessListEntry).values(row);
    await expectCheckViolation(
      ctx.db.insert(accessListEntry).values(row),
      "access_list_entry_uq",
    );
  });

  it("allows the same entity under a different kind", async () => {
    await ctx.db.insert(accessListEntry).values([
      { accessListId: 101, kind: "character", entityId: 5, access: "member" },
      { accessListId: 101, kind: "corporation", entityId: 5, access: "member" },
    ]);
    expect(await ctx.db.select().from(accessListEntry)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
npx vitest run tests/access-lists-schema.test.ts
```

Expected: FAIL at import — `"accessListHolder" is not exported by
"src/db/schema.ts"`. Quote the real output.

- [ ] **Step 3: Add the three enums**

In `src/db/schema.ts`, after `syncRunStatusEnum` (`:31`):

```ts
export const accessListReadStatusEnum = pgEnum("access_list_read_status", [
  "ok",
  "not_visible",
  "failed",
]);
export const esiEntityKindEnum = pgEnum("esi_entity_kind", [
  "character",
  "corporation",
  "alliance",
]);
export const accessListEntryKindEnum = pgEnum("access_list_entry_kind", [
  "character",
  "corporation",
  "alliance",
]);
export type AccessListReadStatus =
  (typeof accessListReadStatusEnum.enumValues)[number];
```

`AccessListReadStatus` is exported here, unconditionally, in the same shape
`SyncRunStatus` already uses (`src/db/schema.ts:39`). Tasks 9, 10 and 12 all
import it; declaring it at the enum keeps that import from becoming a
conditional edit inside a later task whose `git add` does not list the schema.

Two enums with identical members is deliberate: `esi_entity_kind` describes what
a cached name *is* and `access_list_entry_kind` describes what a grant *targets*.
They are free to diverge (a name cache could gain `faction`; a grant could not),
and merging them would couple two tables that have no reason to move together.

- [ ] **Step 4: Add `integer` to the pg-core import**

`src/db/schema.ts:1-15` does not import it yet. The list is alphabetical:

```ts
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
```

- [ ] **Step 5: Add the six tables**

Append after `universeName` (`:245`):

```ts
/**
 * The designated ACL holder: the one character whose token reads every watched
 * access list. Singleton by construction — `id` is pinned to 1 by a check
 * constraint, so "replace the holder" is an UPDATE and there is no way to end
 * up with two.
 *
 * The FK CASCADES deliberately. The default (NO ACTION) would make
 * `delete(character)` fail with a constraint violation for whoever happens to
 * be the holder, breaking both existing deletion paths — unlink
 * (src/services/accounts.ts:198-205) and transfer reclaim (:482-505, :583-609).
 * `set null` is not available because the column is NOT NULL, so cascade it is:
 * unlinking the holder's character silently drops the designation and the page
 * falls back to its "no holder designated" state, which it already renders as a
 * first-class case rather than an error.
 */
export const accessListHolder = pgTable(
  "access_list_holder",
  {
    id: integer("id").primaryKey(),
    characterId: bigint("character_id", { mode: "number" })
      .notNull()
      .references(() => character.id, { onDelete: "cascade" }),
    designatedAt: timestamp("designated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    designatedBy: text("designated_by").notNull(), // account uuid or "system"
  },
  (t) => [check("access_list_holder_singleton_ck", sql`${t.id} = 1`)],
);

/**
 * Every list the holder can currently see, and the cache of their names —
 * `/access-lists` returns ids only, so a name costs its own detail call.
 * Discovery reconciles this against what the holder sees rather than rebuilding
 * it, so it stays one holder's world and never a merge of several;
 * `observedByCharacterId` records whose.
 */
export const accessListCatalog = pgTable("access_list_catalog", {
  accessListId: bigint("access_list_id", { mode: "number" }).primaryKey(),
  name: text("name").notNull(),
  discoveredAt: timestamp("discovered_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  observedByCharacterId: bigint("observed_by_character_id", { mode: "number" }).notNull(),
});

/** The shared watchlist. Curated by admins; not per-admin by design. */
export const accessListWatch = pgTable("access_list_watch", {
  accessListId: bigint("access_list_id", { mode: "number" }).primaryKey(),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  addedBy: text("added_by").notNull(), // account uuid
});

/**
 * One row per watched list, split from its entries so three states stay
 * distinguishable: read succeeded and the list is empty (row, zero entries),
 * never read (no row), and read failed (row with readStatus ≠ ok and the last
 * good observedAt still in place).
 *
 * Two timestamps, not one. `observedAt` is the last SUCCESSFUL read and is null
 * until there is one; `lastAttemptAt` + `readStatus` + `detail` describe the
 * most recent attempt whether it worked or not. Collapsing them forces a choice
 * between lying about freshness and discarding the failure.
 */
export const accessListSnapshot = pgTable("access_list_snapshot", {
  accessListId: bigint("access_list_id", { mode: "number" }).primaryKey(),
  observedAt: timestamp("observed_at", { withTimezone: true }),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }).notNull(),
  readStatus: accessListReadStatusEnum("read_status").notNull(),
  observedByCharacterId: bigint("observed_by_character_id", { mode: "number" }).notNull(),
  name: text("name"),
  description: text("description"),
  allowEveryone: boolean("allow_everyone"),
  detail: text("detail"),
});

/**
 * Membership rows, replaced per list inside the same transaction as its
 * snapshot. `access` is stored verbatim as text: CCP adding a value must not
 * be able to fail a read of a field nothing branches on.
 */
export const accessListEntry = pgTable(
  "access_list_entry",
  {
    id: serial("id").primaryKey(),
    accessListId: bigint("access_list_id", { mode: "number" }).notNull(),
    kind: accessListEntryKindEnum("kind").notNull(),
    entityId: bigint("entity_id", { mode: "number" }).notNull(),
    access: text("access").notNull(),
  },
  (t) => [unique("access_list_entry_uq").on(t.accessListId, t.kind, t.entityId)],
);

/**
 * Name cache for the ids access-list entries carry.
 *
 * Fork operators: unlike `universe_name` above, personal data DOES land here.
 * `character` rows are EVE character names — people, not places — including
 * people who are not your members, since an access list can grant anyone. Corp
 * and alliance names are public. Nothing here is a secret (every one of these
 * names is visible in-game to anyone who looks the id up), but they are stored
 * in your database and rendered on the admin monitor page. Safe to truncate at
 * any time; it refills on the next job run at the cost of some ESI calls, and
 * the page renders unresolved ids bare in the meantime rather than failing.
 *
 * Kept separate from `universe_name` precisely so that table's promise — "no
 * personal data lands here" — stays true.
 */
export const esiEntityName = pgTable("esi_entity_name", {
  id: bigint("id", { mode: "number" }).primaryKey(),
  kind: esiEntityKindEnum("kind").notNull(),
  name: text("name").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 6: Register the tables for truncation**

`tests/helpers/db.ts` truncates via `MANAGED_TABLES`, and
`tests/seed-dev.test.ts` asserts that list matches the database — so omitting
this step fails a test rather than silently leaking rows between cases. In
`src/db/tables.ts`, append inside `MANAGED_TABLES` after `"payout_payment"`:

```ts
  "payout_payment",
  "access_list_holder",
  "access_list_catalog",
  "access_list_watch",
  "access_list_snapshot",
  "access_list_entry",
  "esi_entity_name",
] as const;
```

- [ ] **Step 7: Generate the migration**

```bash
npm run db:generate
git status --short drizzle/
```

Expected: one new `drizzle/0012_<random-name>.sql` plus modified
`drizzle/meta/_journal.json` and a new `drizzle/meta/0012_snapshot.json`. Never
hand-edit either.

- [ ] **Step 8: Read the generated SQL and confirm the two load-bearing clauses**

```bash
grep -nE "ON DELETE cascade|access_list_holder_singleton_ck|access_list_entry_uq" \
  drizzle/0012_*.sql
```

Expected: three matches — the holder FK carrying `ON DELETE cascade`, the
`CHECK ("access_list_holder"."id" = 1)` named `access_list_holder_singleton_ck`,
and the unique constraint on `(access_list_id, kind, entity_id)`. Then read the
whole file:

```bash
cat drizzle/0012_*.sql
```

Confirm it contains only `CREATE TYPE` / `CREATE TABLE` / `ALTER TABLE ... ADD
CONSTRAINT` — no `DROP`. A generated `DROP` means the schema edit disturbed an
existing table and must be investigated before the migration is committed.

- [ ] **Step 9: Apply the migration and run the test**

```bash
npx vitest run tests/access-lists-schema.test.ts
```

`setupTestDb` runs `migrate()` itself, so no separate `db:migrate` is needed for
the test database. Expected: all four cases pass. Quote the real output.

- [ ] **Step 10: Run the tests the schema list touches**

```bash
npx vitest run tests/seed-dev.test.ts
npm run typecheck
```

Expected: both pass. `seed-dev.test.ts` is the one that fails if Step 6 was
skipped; if it fails here, the `MANAGED_TABLES` entry is missing or misspelled,
not the migration.

- [ ] **Step 11: Format check**

```bash
npm run format:check
```

Expected: pass. Quote the real output. Generated SQL is covered by prettier's
glob, so a failure here is usually the schema file, not `drizzle/`.

- [ ] **Step 12: Commit**

```bash
git add src/db/schema.ts src/db/tables.ts drizzle/ tests/access-lists-schema.test.ts
git commit -m "feat(db): add the access-list monitor tables, holder cascading on unlink"
```

---

### Task 4: Pure comparison — `src/core/access-list-compare.ts`

**Files:**

- Create: `src/core/access-list-compare.ts`
- Test: `tests/access-list-compare.test.ts`

**Interfaces:**

- Consumes: nothing. `src/core/` is pure — no db handle, no fetch, no ambient
  clock. This task depends on no earlier task and could be done first.
- Produces:

```ts
export type RosterCharacter = {
  characterId: number;
  name: string;
  accountId: string;
  corporationId: number | null;
  allianceId: number | null;
};
export type AccessEntry = {
  kind: "character" | "corporation" | "alliance";
  entityId: number;
  access: string;
};
export type BroadGrant = {
  kind: "everyone" | "corporation" | "alliance";
  entityId: number | null;
  coveredMembers: number;
};
export type AccessListComparison = {
  missingAccess: RosterCharacter[];
  nonMembers: number[];
  matched: number;
  broadGrants: BroadGrant[];
};
export function compareAccessList(input: {
  allowEveryone: boolean;
  entries: AccessEntry[];
  roster: RosterCharacter[];
}): AccessListComparison;
```

Consumed by Task 7 (the job) and the page's `view.ts`.

- [ ] **Step 1: Read the model this follows**

Read `src/core/acl-diff.ts` (29 lines) and `tests/acl-diff.test.ts` (62 lines) in
full. The shape to copy: one exported function taking a single `input` object,
one exported type per input concept, a docblock that states the *rule* rather
than restating the code, and a test file of small `it(...)` cases each asserting
one whole returned object with `toEqual`.

The shape NOT to copy is the vocabulary. `diffAcl` returns `add` / `remove` /
`unblock` because Wanderer is a third-party ACL authGD **writes** to. The ESI
access-list endpoints are read-only (spec: *Purpose*), so add/remove naming here
would name a mutation this feature cannot perform. That is why this module is
`compareAccessList` with `missingAccess` / `nonMembers`, and why it lives in a
separate file from `acl-diff.ts` despite sharing the letters "ACL".

- [ ] **Step 2: Write the failing test**

Create `tests/access-list-compare.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  compareAccessList,
  type AccessEntry,
  type RosterCharacter,
} from "@/core/access-list-compare";

/** A roster character with the two affiliation columns spelled out per case. */
const member = (
  characterId: number,
  affiliation: { corporationId?: number | null; allianceId?: number | null } = {},
): RosterCharacter => ({
  characterId,
  name: `Char ${characterId}`,
  accountId: `acct-${characterId}`,
  corporationId: affiliation.corporationId ?? null,
  allianceId: affiliation.allianceId ?? null,
});

const entry = (
  kind: AccessEntry["kind"],
  entityId: number,
  access = "blocked_by_default",
): AccessEntry => ({ kind, entityId, access });

describe("compareAccessList", () => {
  it("grants effective access when the character itself is listed", () => {
    expect(
      compareAccessList({
        allowEveryone: false,
        entries: [entry("character", 1)],
        roster: [member(1)],
      }),
    ).toEqual({ missingAccess: [], nonMembers: [], matched: 1, broadGrants: [] });
  });

  it("grants effective access through the character's corporation", () => {
    const result = compareAccessList({
      allowEveryone: false,
      entries: [entry("corporation", 500)],
      roster: [member(1, { corporationId: 500 })],
    });
    expect(result.missingAccess).toEqual([]);
    expect(result.matched).toBe(1);
  });

  it("grants effective access through the character's alliance", () => {
    const result = compareAccessList({
      allowEveryone: false,
      entries: [entry("alliance", 900)],
      roster: [member(1, { corporationId: 500, allianceId: 900 })],
    });
    expect(result.missingAccess).toEqual([]);
    expect(result.matched).toBe(1);
  });

  it("grants effective access to everyone when allowEveryone is set", () => {
    const result = compareAccessList({
      allowEveryone: true,
      entries: [],
      roster: [member(1), member(2)],
    });
    expect(result.missingAccess).toEqual([]);
    expect(result.matched).toBe(2);
  });

  it("reports allowEveryone as a broad grant, because zero missing is by construction", () => {
    // A list open to everyone has no missing members BY CONSTRUCTION. Reporting
    // only "0 discrepancies" would read as "correctly configured" when it means
    // "open to everyone" (spec: Discrepancy means effective access).
    const result = compareAccessList({
      allowEveryone: true,
      entries: [],
      roster: [member(1), member(2)],
    });
    expect(result.missingAccess).toHaveLength(0);
    expect(result.broadGrants).toEqual([
      { kind: "everyone", entityId: null, coveredMembers: 2 },
    ]);
  });

  it("fills both buckets: members with no access, and listed characters we do not know", () => {
    const result = compareAccessList({
      allowEveryone: false,
      entries: [entry("character", 1), entry("character", 77)],
      roster: [member(1), member(2)],
    });
    expect(result.missingAccess.map((c) => c.characterId)).toEqual([2]);
    expect(result.nonMembers).toEqual([77]);
    expect(result.matched).toBe(1);
  });

  it("counts our own covered members on a corporation grant, and claims no more", () => {
    // The count is partial by design: authGD stores a corporationId per
    // character but holds no corp roster, so it can say "covers 2 of ours" and
    // never "covers 2 in total".
    const result = compareAccessList({
      allowEveryone: false,
      entries: [entry("corporation", 500), entry("corporation", 501)],
      roster: [
        member(1, { corporationId: 500 }),
        member(2, { corporationId: 500 }),
        member(3, { corporationId: 999 }),
      ],
    });
    expect(result.broadGrants).toEqual([
      { kind: "corporation", entityId: 500, coveredMembers: 2 },
      { kind: "corporation", entityId: 501, coveredMembers: 0 },
    ]);
    expect(result.missingAccess.map((c) => c.characterId)).toEqual([3]);
    expect(result.matched).toBe(2);
  });

  it("counts our own covered members on an alliance grant", () => {
    const result = compareAccessList({
      allowEveryone: false,
      entries: [entry("alliance", 900)],
      roster: [
        member(1, { corporationId: 500, allianceId: 900 }),
        member(2, { corporationId: 501, allianceId: null }),
      ],
    });
    expect(result.broadGrants).toEqual([
      { kind: "alliance", entityId: 900, coveredMembers: 1 },
    ]);
    expect(result.missingAccess.map((c) => c.characterId)).toEqual([2]);
  });

  it("treats an empty list as every member missing, with nothing to report back", () => {
    expect(
      compareAccessList({
        allowEveryone: false,
        entries: [],
        roster: [member(1), member(2)],
      }),
    ).toEqual({
      missingAccess: [member(1), member(2)],
      nonMembers: [],
      matched: 0,
      broadGrants: [],
    });
  });

  it("is empty in every bucket when both sides are empty", () => {
    expect(
      compareAccessList({ allowEveryone: false, entries: [], roster: [] }),
    ).toEqual({ missingAccess: [], nonMembers: [], matched: 0, broadGrants: [] });
  });

  it("never matches a null affiliation against an entity id", () => {
    // A character with no recorded corporation must not accidentally match a
    // corporation grant; null is "unknown", not "id 0".
    const result = compareAccessList({
      allowEveryone: false,
      entries: [entry("corporation", 500), entry("alliance", 900)],
      roster: [member(1)],
    });
    expect(result.missingAccess.map((c) => c.characterId)).toEqual([1]);
  });
});
```

- [ ] **Step 3: Run the test and watch it fail**

Run: `npx vitest run tests/access-list-compare.test.ts`

Expected: FAIL to collect the suite, with
`Error: Failed to load url /src/core/access-list-compare.ts` — the module does
not exist yet.

- [ ] **Step 4: Implement `compareAccessList`**

Create `src/core/access-list-compare.ts`:

```ts
/** A member character as the roster query returns it (`getMemberCharacters`). */
export type RosterCharacter = {
  characterId: number;
  name: string;
  accountId: string;
  corporationId: number | null;
  allianceId: number | null;
};

/** One membership row of an ESI access list. `access` is verbatim ESI text. */
export type AccessEntry = {
  kind: "character" | "corporation" | "alliance";
  entityId: number;
  access: string;
};

/**
 * A grant that reaches beyond the characters it names. `coveredMembers` counts
 * OUR members only — authGD holds no corp or alliance roster, so the true
 * total is unknowable from here and the page must never imply otherwise.
 */
export type BroadGrant = {
  kind: "everyone" | "corporation" | "alliance";
  entityId: number | null; // null for "everyone"
  coveredMembers: number;
};

export type AccessListComparison = {
  missingAccess: RosterCharacter[];
  nonMembers: number[];
  matched: number;
  broadGrants: BroadGrant[];
};

/**
 * Compares one access list against the member roster on EFFECTIVE access: a
 * member has access if their character is listed, OR their corporation is, OR
 * their alliance is, OR the list allows everyone.
 *
 * Deliberately not `add`/`remove` shaped like `src/core/acl-diff.ts`. The ESI
 * access-list endpoints are read-only, so that vocabulary would name a
 * mutation this feature cannot perform; every correction is an in-game action
 * a human takes.
 *
 * `nonMembers` is complete only for explicit `character` entries. A corp or
 * alliance grant may cover any number of people we cannot enumerate, so those
 * are surfaced as `broadGrants` with our own partial count instead of being
 * silently folded into a total.
 */
export function compareAccessList(input: {
  allowEveryone: boolean;
  entries: AccessEntry[];
  roster: RosterCharacter[];
}): AccessListComparison {
  const listedCharacters = new Set<number>();
  // Insertion-ordered, so broadGrants come out in a stable order for the page.
  const listedCorporations = new Set<number>();
  const listedAlliances = new Set<number>();
  for (const e of input.entries) {
    if (e.kind === "character") listedCharacters.add(e.entityId);
    else if (e.kind === "corporation") listedCorporations.add(e.entityId);
    else listedAlliances.add(e.entityId);
  }

  const hasAccess = (c: RosterCharacter): boolean =>
    input.allowEveryone ||
    listedCharacters.has(c.characterId) ||
    // null is "affiliation unknown", never a matchable id.
    (c.corporationId !== null && listedCorporations.has(c.corporationId)) ||
    (c.allianceId !== null && listedAlliances.has(c.allianceId));

  const missingAccess = input.roster.filter((c) => !hasAccess(c));

  const rosterIds = new Set(input.roster.map((c) => c.characterId));
  // Entries are unique on (list, kind, entityId) in the database, so scanning
  // them straight through cannot produce a duplicate id here.
  const nonMembers = input.entries
    .filter((e) => e.kind === "character" && !rosterIds.has(e.entityId))
    .map((e) => e.entityId);

  const broadGrants: BroadGrant[] = [];
  if (input.allowEveryone) {
    broadGrants.push({
      kind: "everyone",
      entityId: null,
      coveredMembers: input.roster.length,
    });
  }
  for (const id of listedCorporations) {
    broadGrants.push({
      kind: "corporation",
      entityId: id,
      coveredMembers: input.roster.filter((c) => c.corporationId === id).length,
    });
  }
  for (const id of listedAlliances) {
    broadGrants.push({
      kind: "alliance",
      entityId: id,
      coveredMembers: input.roster.filter((c) => c.allianceId === id).length,
    });
  }

  return {
    missingAccess,
    nonMembers,
    matched: input.roster.length - missingAccess.length,
    broadGrants,
  };
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `npx vitest run tests/access-list-compare.test.ts`

Expected: PASS, 11 passed. If the "never matches a null affiliation" case fails,
the null guards in `hasAccess` were dropped.

- [ ] **Step 6: Typecheck and format**

Run: `npm run typecheck && npm run format:check`

Expected: both exit 0. If `format:check` names
`src/core/access-list-compare.ts` or `tests/access-list-compare.test.ts`, run
`npx prettier --write` on the two files and re-run.

- [ ] **Step 7: Commit**

```bash
git add src/core/access-list-compare.ts tests/access-list-compare.test.ts
git commit -m "feat(core): compare an access list against the roster on effective access"
```

---

### Task 5: Entity-name cache — `src/services/entity-names.ts`

**Files:**

- Create: `src/services/entity-names.ts`
- Test: `tests/entity-names.test.ts`

**Interfaces:**

- Consumes, from Task 2 (ESI client):

```ts
export type EsiEntityName = { id: number; name: string; category: string };
getUniverseNames(ids: number[]): Promise<EsiEntityName[]>; // chunked 1000 inside the client
```

Consumes, from Task 3 (schema): the `esiEntityName` table
(`id` bigint PK, `kind` `esi_entity_kind` enum, `name` text, `fetchedAt`
timestamptz) and `esiEntityKindEnum`.

- Produces:

```ts
export type EsiEntityKind = "character" | "corporation" | "alliance";
export async function lookupEntityNames(dbx: Dbx, ids: number[]): Promise<Map<number, string>>;
export async function resolveEntityNames(
  dbx: Dbx,
  esi: Pick<EsiClient, "getUniverseNames">,
  ids: number[],
): Promise<Map<number, string>>;
```

`resolveEntityNames` is called by the job (Task 7); `lookupEntityNames` by the
page's `view.ts`, which must never call ESI.

- [ ] **Step 1: Read the model this mirrors**

Read `src/services/universe-names.ts` in full (91 lines). Three things carry
over verbatim:

1. `lookupCachedNames`'s empty-`inArray` guard (`:85`) — an empty `inArray` is a
   predicate that can never match, so the round trip is skipped.
2. The `onConflictDoUpdate` upsert (`:66-69`).
3. The never-throws contract (`:36-40`): a failed cache read degrades to "no
   cached candidate" rather than rejecting, and a failed fetch returns whatever
   was cached.

What changes: this module is **batch**-shaped (one call for up to 1000 ids)
where `resolveUniverseName` is one-id-at-a-time, and it writes a different
table. The reason for the separate table is not incidental and belongs in the
docblock: `universeName`'s own table comment (`src/db/schema.ts:228-240`)
promises fork operators that "no personal data lands here — systems, NPC
stations and player structures are places, not people". Character names are
people. Reusing that table would make its comment a lie.

- [ ] **Step 2: Write the failing test**

Create `tests/entity-names.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { esiEntityName } from "@/db/schema";
import type { EsiEntityName } from "@/lib/esi/client";
import { lookupEntityNames, resolveEntityNames } from "@/services/entity-names";
import { setupTestDb, truncateAll } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

/** Records every id batch it is asked for, so tests can assert cache hits. */
function fakeEsi(names: Record<number, { name: string; category: string }> | "fail") {
  const calls: number[][] = [];
  return {
    calls,
    esi: {
      getUniverseNames: async (ids: number[]): Promise<EsiEntityName[]> => {
        calls.push([...ids]);
        if (names === "fail") throw new Error("esi down");
        return ids
          .filter((id) => names[id] !== undefined)
          .map((id) => ({ id, name: names[id].name, category: names[id].category }));
      },
    },
  };
}

const seedName = (id: number, name: string, kind: "character" | "corporation") =>
  ctx.db.insert(esiEntityName).values({ id, kind, name, fetchedAt: new Date() });

describe("lookupEntityNames", () => {
  it("returns an empty map for no ids, without touching the database", async () => {
    expect(await lookupEntityNames(ctx.db, [])).toEqual(new Map());
  });

  it("returns only the ids it has cached", async () => {
    await seedName(1, "Alice", "character");
    const found = await lookupEntityNames(ctx.db, [1, 2]);
    expect(found.get(1)).toBe("Alice");
    expect(found.has(2)).toBe(false);
  });
});

describe("resolveEntityNames", () => {
  it("returns immediately for an empty id list and never calls ESI", async () => {
    const { esi, calls } = fakeEsi({});
    expect(await resolveEntityNames(ctx.db, esi, [])).toEqual(new Map());
    expect(calls).toEqual([]);
  });

  it("serves cached ids without calling ESI at all", async () => {
    await seedName(1, "Alice", "character");
    const { esi, calls } = fakeEsi({});
    const names = await resolveEntityNames(ctx.db, esi, [1]);
    expect(names.get(1)).toBe("Alice");
    expect(calls).toEqual([]);
  });

  it("asks ESI only for the misses, and returns cached plus fresh", async () => {
    await seedName(1, "Alice", "character");
    const { esi, calls } = fakeEsi({ 2: { name: "Bravo Corp", category: "corporation" } });
    const names = await resolveEntityNames(ctx.db, esi, [1, 2]);
    expect(calls).toEqual([[2]]);
    expect(names.get(1)).toBe("Alice");
    expect(names.get(2)).toBe("Bravo Corp");
  });

  it("upserts what it resolves, so the next call needs no ESI", async () => {
    const { esi, calls } = fakeEsi({ 7: { name: "Charlie", category: "character" } });
    await resolveEntityNames(ctx.db, esi, [7]);
    await resolveEntityNames(ctx.db, esi, [7]);
    expect(calls).toEqual([[7]]);
    const rows = await ctx.db.select().from(esiEntityName);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 7, kind: "character", name: "Charlie" });
  });

  it("overwrites a cached name when ESI reports a rename", async () => {
    await seedName(7, "Old Name", "character");
    // Force a miss by resolving an id we do not hold, alongside the stale one.
    const { esi } = fakeEsi({ 8: { name: "Delta", category: "character" } });
    const first = await resolveEntityNames(ctx.db, esi, [7, 8]);
    expect(first.get(7)).toBe("Old Name"); // cache-first: no refetch of a hit
    await ctx.db.delete(esiEntityName);
    const { esi: esi2 } = fakeEsi({ 7: { name: "New Name", category: "character" } });
    const second = await resolveEntityNames(ctx.db, esi2, [7]);
    expect(second.get(7)).toBe("New Name");
  });

  it("NEVER throws — an ESI failure returns whatever was cached", async () => {
    await seedName(1, "Alice", "character");
    const { esi } = fakeEsi("fail");
    const names = await resolveEntityNames(ctx.db, esi, [1, 2]);
    expect(names.get(1)).toBe("Alice");
    expect(names.has(2)).toBe(false);
    expect(await ctx.db.select().from(esiEntityName)).toHaveLength(1);
  });

  it("drops categories the cache does not model rather than failing the batch", async () => {
    // getUniverseNames answers for systems and stations too; the enum has three
    // kinds, so anything else would be a constraint violation on insert.
    const { esi } = fakeEsi({
      1: { name: "Alice", category: "character" },
      2: { name: "Jita", category: "solar_system" },
    });
    const names = await resolveEntityNames(ctx.db, esi, [1, 2]);
    expect(names.get(1)).toBe("Alice");
    expect(names.has(2)).toBe(false);
  });

  it("asks for each unresolved id once even when the caller repeats it", async () => {
    const { esi, calls } = fakeEsi({ 5: { name: "Echo", category: "alliance" } });
    await resolveEntityNames(ctx.db, esi, [5, 5, 5]);
    expect(calls).toEqual([[5]]);
  });
});
```

- [ ] **Step 3: Run the test and watch it fail**

Run: `npx vitest run tests/entity-names.test.ts`

Expected: FAIL to collect, `Failed to load url /src/services/entity-names.ts`.

- [ ] **Step 4: Implement `src/services/entity-names.ts`**

```ts
import { inArray, sql } from "drizzle-orm";
import type { Dbx } from "@/db";
import { esiEntityName } from "@/db/schema";
import type { EsiClient } from "@/lib/esi/client";

/**
 * Names for characters, corporations and alliances.
 *
 * Deliberately NOT `universeName`. That table's comment promises fork
 * operators that "no personal data lands here — systems, NPC stations and
 * player structures are places, not people" (src/db/schema.ts). Character
 * names are people, so they get their own table carrying its own honest
 * comment rather than quietly invalidating that one. The split is natural
 * anyway: this cache is batch-shaped around `POST /universe/names/` (1000 ids
 * per call) where `resolveUniverseName` is one id at a time.
 *
 * No TTL. These names change rarely, nothing acts on them — they are read out
 * to an admin who retypes them in-game — and a stale name beats a bare id.
 */
export type EsiEntityKind = "character" | "corporation" | "alliance";

/** The ESI categories this cache models; anything else is dropped on write. */
const CACHED_KINDS: ReadonlySet<string> = new Set([
  "character",
  "corporation",
  "alliance",
]);

/** Names for a batch of ids, read from the cache only. No ESI, no writes. */
export async function lookupEntityNames(
  dbx: Dbx,
  ids: number[],
): Promise<Map<number, string>> {
  // An empty `inArray` is a predicate that can never match; skip the round trip.
  if (ids.length === 0) return new Map();
  const rows = await dbx
    .select({ id: esiEntityName.id, name: esiEntityName.name })
    .from(esiEntityName)
    .where(inArray(esiEntityName.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * Cache-first batched lookup. Reads the cache, asks ESI only for the misses,
 * upserts what comes back, and returns cached-plus-fresh.
 *
 * NEVER throws. Names are decoration on a monitoring page: an unresolved id
 * renders bare, which is strictly better than the whole page failing because
 * ESI was briefly unhappy. Both the cache read and the fetch degrade to
 * "return what we have".
 */
export async function resolveEntityNames(
  dbx: Dbx,
  esi: Pick<EsiClient, "getUniverseNames">,
  ids: number[],
): Promise<Map<number, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();

  let names: Map<number, string>;
  try {
    names = await lookupEntityNames(dbx, unique);
  } catch {
    // A failed read degrades to "nothing cached" rather than rejecting.
    names = new Map();
  }
  const missing = unique.filter((id) => !names.has(id));
  if (missing.length === 0) return names;

  try {
    const fetched = await esi.getUniverseNames(missing);
    const fetchedAt = new Date();
    const rows = fetched
      // getUniverseNames also answers for systems, stations and inventory
      // types. `esi_entity_kind` has three values, so an unmodelled category
      // would fail the whole insert — drop it and let the id render bare.
      .filter((n) => CACHED_KINDS.has(n.category))
      .map((n) => ({
        id: n.id,
        kind: n.category as EsiEntityKind,
        name: n.name,
        fetchedAt,
      }));
    if (rows.length > 0) {
      await dbx
        .insert(esiEntityName)
        .values(rows)
        .onConflictDoUpdate({
          target: esiEntityName.id,
          set: {
            kind: sql`excluded.kind`,
            name: sql`excluded.name`,
            fetchedAt: sql`excluded.fetched_at`,
          },
        });
    }
    for (const r of rows) names.set(r.id, r.name);
    return names;
  } catch {
    // Whatever was cached. An id ESI would not or could not name simply has no
    // entry, and the caller renders the number.
    return names;
  }
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `npx vitest run tests/entity-names.test.ts`

Expected: PASS, 10 passed. A failure naming `excluded.fetched_at` means the
generated column name differs from the assumption — read the `esi_entity_name`
CREATE TABLE in the Task 3 migration under `drizzle/` and use the real column
names in the three `sql\`excluded.…\`` fragments.

- [ ] **Step 6: Typecheck and format**

Run: `npm run typecheck && npm run format:check`

Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/services/entity-names.ts tests/entity-names.test.ts
git commit -m "feat(services): batched, cache-first entity-name resolution"
```

---

### Task 6: Holder/watch service + roster affiliations

**Files:**

- Create: `src/services/access-lists.ts`
- Modify: `src/services/desired.ts:6-13` (the `MemberCharacter` type),
  `:37-44` (`getMemberCharacters`'s select), `:66-73`
  (`getLocatableCharacters`'s select — see Step 2, this one is not optional)
- Modify: `tests/helpers/seed.ts:34-72` (a `corporationId` option)
- Test: `tests/access-lists-service.test.ts`, plus one case appended to
  `tests/desired.test.ts`

**Interfaces:**

- Consumes, from Task 3 (schema): `accessListHolder`, `accessListWatch`,
  `accessListCatalog`, `accessListSnapshot`. Consumes `logAudit` from
  `src/services/audit.ts:8-18`.
- Produces:

```ts
export type Holder = { characterId: number; designatedAt: Date; designatedBy: string };
export async function getHolder(dbx: Dbx): Promise<Holder | null>;
export async function designateHolder(db: Db, characterId: number, actor: string): Promise<void>;
export async function getWatchedListIds(dbx: Dbx): Promise<number[]>;
export async function addWatch(db: Db, accessListId: number, actor: string): Promise<void>;
export async function removeWatch(db: Db, accessListId: number, actor: string): Promise<void>;

// src/services/desired.ts — MemberCharacter, additive:
//   corporationId: number | null;
//   allianceId: number | null;
```

`getHolder` and `getWatchedListIds` are consumed by the job (Task 7) and the
page's `view.ts`; the three writers by `actions.ts`. `MemberCharacter`'s two new
fields feed `RosterCharacter` in Task 4.

- [ ] **Step 1: Read the code this joins**

Read `src/services/desired.ts` (78 lines) in full, `src/services/audit.ts:1-18`
(`logAudit`), and `src/services/tokens.ts:142-174` (`getMainCharacterWithScope`
— the shape for "read one row, return a narrow record or null").

**The roster decision, and why the alternative was rejected.** The comparison
needs each member's `corporationId` and `allianceId`. Two ways to get them:

1. Widen `getMemberCharacters` (chosen). Purely additive — every existing
   caller destructures the fields it needs (`src/jobs/wanderer.ts:38` maps to
   `characterId`; `src/jobs/contacts.ts:75` reads token fields), so two extra
   properties break nothing.
2. A second query in `access-lists.ts` with its own tier and
   `affiliationInvalid` predicate (rejected). That is a second copy of the "who
   is a member" test, and `desired.ts:15-19` already says out loud why there
   must not be one: "Kept next to the query so the two cannot drift: change
   one, change both." The spec's stated point is that this page **cannot
   disagree with the contacts and Wanderer syncs about who a member is** — a
   duplicated predicate is exactly how that guarantee dies.

- [ ] **Step 2: Confirm every caller survives the widening**

Run:

```bash
grep -rn "getMemberCharacters\|getLocatableCharacters\|MemberCharacter" src/ tests/ e2e/ scripts/
```

Expected, and each must be checked by eye:

- `src/jobs/wanderer.ts:38` — `.map((c) => c.characterId)`. Unaffected.
- `src/jobs/contacts.ts:24,75` — `Pick<MemberCharacter, "tokenStatus" | "scopes" | "refreshTokenEnc">`. Unaffected.
- `src/jobs/location.ts:7,32` — same `Pick`, but calls **`getLocatableCharacters`**.
- `tests/desired.test.ts`, `tests/contacts-job.test.ts:124` — assertions on
  `characterId` / `toMatchObject`, both tolerant of extra keys.

The one that is **not** merely tolerant: `getLocatableCharacters`
(`desired.ts:64-78`) is also declared `Promise<MemberCharacter[]>`. Widening the
type without widening that select is a typecheck error, not a silent pass. Both
selects change in Step 4.

- [ ] **Step 3: Write the failing tests**

First, append to `tests/desired.test.ts` inside the existing
`describe("getMemberCharacters", …)` block:

```ts
  it("carries corporation and alliance ids, so the access-list page and the syncs share one roster", async () => {
    const member = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, {
      id: 1,
      accountId: member.id,
      main: true,
      corporationId: 500,
      allianceId: 900,
    });
    await seedCharacter(ctx.db, cfg, { id: 2, accountId: member.id });
    const rows = await getMemberCharacters(ctx.db);
    const byId = new Map(rows.map((r) => [r.characterId, r]));
    expect(byId.get(1)).toMatchObject({ corporationId: 500, allianceId: 900 });
    expect(byId.get(2)).toMatchObject({ corporationId: null, allianceId: null });
  });
```

Then create `tests/access-lists-service.test.ts`:

```ts
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accessListCatalog, accessListHolder, accessListWatch, auditLog } from "@/db/schema";
import {
  addWatch,
  designateHolder,
  getHolder,
  getWatchedListIds,
  removeWatch,
} from "@/services/access-lists";
import { setupTestDb, truncateAll } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";

const cfg = testConfig();

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

const audits = () => ctx.db.select().from(auditLog).orderBy(desc(auditLog.id));

/** Two linked characters, so the holder FK has something to point at. */
async function seedTwoCharacters() {
  const acc = await seedAccount(ctx.db, { tier: "member", isAdmin: true });
  await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
  await seedCharacter(ctx.db, cfg, { id: 2, accountId: acc.id });
  return acc;
}

describe("getHolder / designateHolder", () => {
  it("returns null when nothing is designated", async () => {
    expect(await getHolder(ctx.db)).toBeNull();
  });

  it("designates a first holder and audits holder_designated", async () => {
    const acc = await seedTwoCharacters();
    await designateHolder(ctx.db, 1, acc.id);
    expect(await getHolder(ctx.db)).toMatchObject({
      characterId: 1,
      designatedBy: acc.id,
    });
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: acc.id,
      action: "access_list.holder_designated",
      target: "1",
      details: { characterId: 1 },
    });
  });

  it("records BOTH the previous and the new character id when replacing", async () => {
    const acc = await seedTwoCharacters();
    await designateHolder(ctx.db, 1, acc.id);
    await designateHolder(ctx.db, 2, acc.id);
    expect(await getHolder(ctx.db)).toMatchObject({ characterId: 2 });
    const rows = await audits();
    expect(rows[0]).toMatchObject({
      action: "access_list.holder_replaced",
      target: "2",
      details: { previousCharacterId: 1, characterId: 2 },
    });
  });

  it("stays a singleton across repeated designation", async () => {
    const acc = await seedTwoCharacters();
    await designateHolder(ctx.db, 1, acc.id);
    await designateHolder(ctx.db, 2, acc.id);
    const rows = await ctx.db.select().from(accessListHolder);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 1, characterId: 2 });
  });
});

describe("addWatch / removeWatch / getWatchedListIds", () => {
  const seedCatalog = (accessListId: number, name: string) =>
    ctx.db.insert(accessListCatalog).values({
      accessListId,
      name,
      discoveredAt: new Date(),
      observedByCharacterId: 1,
    });

  it("adds a watch and audits the list id and name", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member", isAdmin: true });
    await seedCatalog(42, "Home Structures");
    await addWatch(ctx.db, 42, acc.id);
    expect(await getWatchedListIds(ctx.db)).toEqual([42]);
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: acc.id,
      action: "access_list.watch_added",
      target: "42",
      details: { accessListId: 42, name: "Home Structures" },
    });
  });

  it("removes a watch and audits the list id and name", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member", isAdmin: true });
    await seedCatalog(42, "Home Structures");
    await addWatch(ctx.db, 42, acc.id);
    await removeWatch(ctx.db, 42, acc.id);
    expect(await getWatchedListIds(ctx.db)).toEqual([]);
    expect(await ctx.db.select().from(accessListWatch)).toHaveLength(0);
    const rows = await audits();
    expect(rows[0]).toMatchObject({
      action: "access_list.watch_removed",
      target: "42",
      details: { accessListId: 42, name: "Home Structures" },
    });
  });

  it("audits a null name for a list that is no longer in the catalog", async () => {
    // The usual reason to remove a watch: the holder can no longer see the
    // list, so discovery dropped it. An unnamed row still audits.
    const acc = await seedAccount(ctx.db, { tier: "member", isAdmin: true });
    await addWatch(ctx.db, 7, acc.id);
    await removeWatch(ctx.db, 7, acc.id);
    const rows = await audits();
    expect(rows[0]).toMatchObject({
      action: "access_list.watch_removed",
      details: { accessListId: 7, name: null },
    });
  });

  it("writes no audit row when nothing actually changed", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member", isAdmin: true });
    await addWatch(ctx.db, 7, acc.id);
    await addWatch(ctx.db, 7, acc.id); // already watched
    await removeWatch(ctx.db, 8, acc.id); // never watched
    expect(await audits()).toHaveLength(1);
  });

  it("returns watched ids in a stable order", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member", isAdmin: true });
    await addWatch(ctx.db, 9, acc.id);
    await addWatch(ctx.db, 3, acc.id);
    expect(await getWatchedListIds(ctx.db)).toEqual([3, 9]);
  });
});
```

- [ ] **Step 4: Run both suites and watch them fail**

Run: `npx vitest run tests/access-lists-service.test.ts tests/desired.test.ts`

Expected: `access-lists-service.test.ts` fails to collect with
`Failed to load url /src/services/access-lists.ts`. `desired.test.ts` fails the
new case with `Object literal may only specify known properties, and 'corporationId' does not exist`
at the `seedCharacter` call — the helper option is added in Step 5.

- [ ] **Step 5: Add the seed helper option**

In `tests/helpers/seed.ts`, add to `seedCharacter`'s `opts` type, beside the
existing `allianceId`:

```ts
    corporationId?: number | null;
```

and to the `.values({ … })` object, beside `allianceId`:

```ts
      corporationId: opts.corporationId ?? null,
```

- [ ] **Step 6: Widen `MemberCharacter` and BOTH selects**

In `src/services/desired.ts`, add to the type:

```ts
export type MemberCharacter = {
  characterId: number;
  accountId: string;
  name: string;
  /** Affiliation, as the membership job last recorded it. Null means never
   * read — it is not a matchable id, and the access-list comparison treats it
   * that way. */
  corporationId: number | null;
  allianceId: number | null;
  refreshTokenEnc: string | null;
  tokenStatus: "valid" | "invalid" | "needs_reauth" | "missing";
  scopes: string[];
};
```

and add the same two lines to **both** selects — `getMemberCharacters` and
`getLocatableCharacters`, which is also typed `Promise<MemberCharacter[]>`:

```ts
      corporationId: character.corporationId,
      allianceId: character.allianceId,
```

- [ ] **Step 7: Implement `src/services/access-lists.ts`**

```ts
import { asc, eq } from "drizzle-orm";
import type { Db, Dbx } from "@/db";
import {
  accessListCatalog,
  accessListHolder,
  accessListSnapshot,
  accessListWatch,
} from "@/db/schema";
import { logAudit } from "@/services/audit";

/**
 * The holder table is a singleton enforced by `CHECK (id = 1)`. The constant
 * exists so every read and write spells the key the same way; a literal `1`
 * scattered across call sites is how a second row eventually appears.
 */
const HOLDER_ROW_ID = 1;

export type Holder = {
  characterId: number;
  designatedAt: Date;
  designatedBy: string;
};

export async function getHolder(dbx: Dbx): Promise<Holder | null> {
  const [row] = await dbx
    .select({
      characterId: accessListHolder.characterId,
      designatedAt: accessListHolder.designatedAt,
      designatedBy: accessListHolder.designatedBy,
    })
    .from(accessListHolder)
    .where(eq(accessListHolder.id, HOLDER_ROW_ID));
  return row ?? null;
}

/**
 * Points the monitor at a character, in one transaction so the audit row and
 * the designation cannot disagree.
 *
 * A replacement is a real event with consequences — a different holder may see
 * a different set of lists, and watched rows can go "not visible to holder" —
 * so it audits under its own action carrying BOTH ids. `designatedBy` records
 * only the current state, so without this row a replacement leaves no trace of
 * what it displaced (CONTRIBUTING.md: every state change writes an audit row).
 *
 * Re-designating the character that is already the holder still rewrites
 * `designatedBy`/`designatedAt` and so still audits, as a replace.
 */
export async function designateHolder(
  db: Db,
  characterId: number,
  actor: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const previous = await getHolder(tx);
    const designatedAt = new Date();
    await tx
      .insert(accessListHolder)
      .values({ id: HOLDER_ROW_ID, characterId, designatedAt, designatedBy: actor })
      .onConflictDoUpdate({
        target: accessListHolder.id,
        set: { characterId, designatedAt, designatedBy: actor },
      });
    await logAudit(tx, {
      actor,
      action: previous
        ? "access_list.holder_replaced"
        : "access_list.holder_designated",
      target: String(characterId),
      details: previous
        ? { previousCharacterId: previous.characterId, characterId }
        : { characterId },
    });
  });
}

export async function getWatchedListIds(dbx: Dbx): Promise<number[]> {
  const rows = await dbx
    .select({ accessListId: accessListWatch.accessListId })
    .from(accessListWatch)
    .orderBy(asc(accessListWatch.accessListId));
  return rows.map((r) => r.accessListId);
}

/**
 * The list's name for the audit row. The catalog is reconciled against what the
 * holder can currently see on every discovery, so a list that went invisible
 * has no catalog row — fall back to the last snapshot, then to null. An id with
 * no name anywhere still audits; a missing name must never cost the row.
 */
async function watchedListName(dbx: Dbx, accessListId: number): Promise<string | null> {
  const [cat] = await dbx
    .select({ name: accessListCatalog.name })
    .from(accessListCatalog)
    .where(eq(accessListCatalog.accessListId, accessListId));
  if (cat?.name) return cat.name;
  const [snap] = await dbx
    .select({ name: accessListSnapshot.name })
    .from(accessListSnapshot)
    .where(eq(accessListSnapshot.accessListId, accessListId));
  return snap?.name ?? null;
}

/**
 * Adds a list to the shared watchlist. Idempotent: watching an already-watched
 * list changes nothing and therefore audits nothing, so a double submit does
 * not manufacture history.
 */
export async function addWatch(
  db: Db,
  accessListId: number,
  actor: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(accessListWatch)
      .values({ accessListId, addedAt: new Date(), addedBy: actor })
      .onConflictDoNothing({ target: accessListWatch.accessListId })
      .returning({ accessListId: accessListWatch.accessListId });
    if (inserted.length === 0) return;
    await logAudit(tx, {
      actor,
      action: "access_list.watch_added",
      target: String(accessListId),
      details: { accessListId, name: await watchedListName(tx, accessListId) },
    });
  });
}

/** Removes a list from the watchlist. Audits only when a row actually went. */
export async function removeWatch(
  db: Db,
  accessListId: number,
  actor: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    // Read the name BEFORE the delete: nothing here cascades to the snapshot,
    // but reading first keeps the audit row correct regardless of what a later
    // change makes the delete cascade to.
    const name = await watchedListName(tx, accessListId);
    const removed = await tx
      .delete(accessListWatch)
      .where(eq(accessListWatch.accessListId, accessListId))
      .returning({ accessListId: accessListWatch.accessListId });
    if (removed.length === 0) return;
    await logAudit(tx, {
      actor,
      action: "access_list.watch_removed",
      target: String(accessListId),
      details: { accessListId, name },
    });
  });
}
```

- [ ] **Step 8: Run the new tests and watch them pass**

Run: `npx vitest run tests/access-lists-service.test.ts tests/desired.test.ts`

Expected: PASS, 13 passed across the two files.

- [ ] **Step 9: Run every suite that touches the widened roster**

Run: `npx vitest run tests/contacts-job.test.ts tests/wanderer-job.test.ts tests/location-job.test.ts tests/account-view.test.ts`

Expected: all PASS unchanged. This is the empirical half of Step 2's grep — the
widening is additive, so any failure here means a caller was doing something
stricter than destructuring (a `toEqual` on a whole row, say) and must be
inspected rather than loosened by reflex.

- [ ] **Step 10: Typecheck and format**

Run: `npm run typecheck && npm run format:check`

Expected: both exit 0. A typecheck error at `src/services/desired.ts:64`
(`getLocatableCharacters`) means Step 6's second select was missed.

- [ ] **Step 11: Commit**

```bash
git add src/services/access-lists.ts src/services/desired.ts tests/helpers/seed.ts \
        tests/access-lists-service.test.ts tests/desired.test.ts
git commit -m "feat(services): access-list holder and watchlist, with roster affiliations"
```

---

### Task 7: The job and its registration

**Files:**
- Create: `src/jobs/access-lists.ts`
- Modify: `src/core/schedules.ts:10-22` (`JOB_CRON`), `src/core/schedules.ts:70-79` (`JOB_GROUP`)
- Modify: `src/worker/queues.ts:4-14` (`QUEUES`), `src/worker/queues.ts:39-48` (`JOB_QUEUES`)
- Modify: `src/worker/handlers.ts:14-48` (schema + `JobDeps`), `src/worker/handlers.ts:59-92` (handler map)
- Test: `tests/access-lists-job.test.ts`
- Test (existing, must still pass): `tests/dispatcher.test.ts`

**Interfaces:**
- Consumes (Tasks 1–6):
  - `ACCESS_LISTS_SCOPE = "esi-access.read_lists.v1"`, `type AccessListsEsi = Pick<EsiClient, "getAccessLists" | "getAccessList" | "getUniverseNames">`, `type EsiAccessList` — from `@/lib/esi/client`
  - `getHolder(dbx: Dbx): Promise<Holder | null>` — from `@/services/access-lists`
  - `getWatchedListIds(dbx: Dbx): Promise<number[]>` — from `@/services/access-lists`
  - `resolveEntityNames(dbx: Dbx, esi: Pick<EsiClient, "getUniverseNames">, ids: number[]): Promise<Map<number, string>>` — from `@/services/entity-names`
  - `accessListCatalog`, `accessListSnapshot`, `accessListEntry`, `character` — from `@/db/schema`
- Consumes (existing):
  - `runJob(db, jobType, fn): Promise<JobResult>`, `JobRetryError` — `@/services/sync-run`
  - `getFreshAccessToken(db, cfg, ch, fetchImpl?): Promise<AccessTokenResult>` — `@/services/tokens`
  - `EsiError` with `kind: "needs_reauth" | "permanent" | "transient"` and `status: number` — `@/lib/esi/client`
- Produces:
  - `export async function runAccessListsJob(deps: { db: Db; cfg: Config; esi: AccessListsEsi; fetchImpl?: typeof fetch }): Promise<JobResult>`
  - `QUEUES.accessLists = "access-lists"`, `JOB_CRON["access-lists"] = "25 * * * *"`, `JOB_GROUP["access-lists"] = "on-demand"`

Counts keys, exactly: `lists`, `watched`, `read`, `failed`, `skipped`, `noHolder`,
`scopeMissing`, `holderChanged`, `named`, `namesResolved`.

This task lands as ONE commit. An earlier draft split it into registration
(Steps 1–5) and the job body (Steps 6–13), but the registration commit alone
does not typecheck: `JOB_HANDLERS` would name a module that does not exist yet.
Do all thirteen steps, then commit once at Step 13.

---

- [ ] **Step 1: Run the existing dispatcher test first, to establish the baseline**

`tests/dispatcher.test.ts:129` asserts `[...RERUNNABLE].sort()` equals
`Object.keys(JOB_CRON).sort()`. `RERUNNABLE` derives from `QUEUES`
(`src/worker/dispatcher.ts:22-24`), so that one line is a cross-check between
the two files this step is about to edit — it fails if `QUEUES` gains a key
`JOB_CRON` does not, or vice versa. Run it green before touching anything, so a
later red is unambiguously this task's doing.

Run: `npx vitest run tests/dispatcher.test.ts`
Expected: PASS.

- [ ] **Step 2: Add the queue**

`src/worker/queues.ts` — two edits, both inside existing literals:

```ts
export const QUEUES = {
  membership: "membership",
  membershipRecheck: "membership-recheck",
  contacts: "contacts",
  wanderer: "wanderer",
  discordRoles: "discord-roles",
  tokenHealth: "token-health",
  purge: "purge",
  location: "location",
  accessLists: "access-lists",
  deadLetter: "ops-dead-letter",
} as const;
```

```ts
const JOB_QUEUES = [
  QUEUES.membership,
  QUEUES.membershipRecheck,
  QUEUES.contacts,
  QUEUES.wanderer,
  QUEUES.discordRoles,
  QUEUES.tokenHealth,
  QUEUES.purge,
  QUEUES.location,
  QUEUES.accessLists,
] as const;
```

No `GLOBAL_SINGLETON_KEYS` entry: the default `${queue}:all` shape applies, so
a scheduled `:25` tick and a "Check now" click coalesce rather than
double-queueing (`src/worker/queues.ts:34-37`).

- [ ] **Step 3: Add the cron and the group**

`src/core/schedules.ts`, inside `JOB_CRON`, after `location`:

```ts
  // :25 is a free slot — :00/:30 membership, :05 contacts, :10 wanderer,
  // :15 discord-roles, :02,17,32,47 location. A read-only monitor has no
  // reason to contend with the jobs that push member state outward.
  "access-lists": "25 * * * *",
```

and inside `JOB_GROUP`:

```ts
  "access-lists": "on-demand",
```

`on-demand`, not `sweep`: `sweep` is defined in the comment above `JOB_GROUP`
as "the four jobs the primary 'sync everything' fan-out enqueues"
(`src/core/schedules.ts:51-52`), and that fan-out is a hardcoded list in
`jobsFor({kind:"all"})` (`src/core/dispatch-plan.ts:67-73`). Labelling this
`sweep` without editing that list would make the group name a lie.
`JOB_GROUP` is a `Record<JobType, JobGroup>`, so the cron key without this
entry is a compile error — the two edits cannot drift apart.

**`jobsFor` is deliberately left untouched.** A read-only monitor has no
business being triggered by "sync everything", which exists to push member
state outward. `RERUNNABLE` also needs no edit: it derives from `QUEUES`
(`src/worker/dispatcher.ts:22-24`), and `isJobType` is the runtime gate
(`src/core/dispatch-plan.ts:74-81`).

- [ ] **Step 4: Add the handler**

`src/worker/handlers.ts` — the schema beside its siblings:

```ts
const accessListsSchema = z.object({ jobType: z.literal(QUEUES.accessLists) }).strict();
```

`JobDeps.esi` widened by intersection, per the `ContactsEsi`/`LocationEsi`
pattern already there:

```ts
  esi: Pick<EsiClient, "postAffiliation"> & ContactsEsi & LocationEsi & AccessListsEsi;
```

the import:

```ts
import { runAccessListsJob } from "@/jobs/access-lists";
import type { AccessListsEsi } from "@/lib/esi/client";
```

and the map entry:

```ts
    [QUEUES.accessLists]: async (data) => {
      accessListsSchema.parse(data);
      await runAccessListsJob(deps);
    },
```

This will not compile until Step 6 creates the module — that is expected, and
Step 5 runs the queue/cron cross-check that does not depend on it. **Do not
commit here.** The tree does not typecheck until Step 8, and a commit that
cannot typecheck breaks `git bisect` and any CI run that lands on it.

- [ ] **Step 5: Prove the registration did not drift**

Run: `npx vitest run tests/dispatcher.test.ts`
Expected: PASS — `RERUNNABLE` now contains `access-lists` from `QUEUES`, and
`JOB_CRON` gained the matching key, so line 129 still balances. A failure here
means Step 2 and Step 3 disagree.

`npm run typecheck` is expected to FAIL at this point, on the missing
`@/jobs/access-lists` import alone. Step 12 is where it must pass.

---

- [ ] **Step 6: Write the failing test**

Create `tests/access-lists-job.test.ts`. Fake ESI, real DB — the shape of
`tests/contacts-job.test.ts:21-58`.

```ts
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  accessListCatalog,
  accessListEntry,
  accessListHolder,
  accessListSnapshot,
  accessListWatch,
} from "@/db/schema";
import { runAccessListsJob } from "@/jobs/access-lists";
import {
  ACCESS_LISTS_SCOPE,
  EsiError,
  type AccessListsEsi,
  type EsiAccessList,
} from "@/lib/esi/client";
import { setupTestDb, truncateAll } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";

const cfg = testConfig();
const HOLDER = 1000;

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

/** A refresh that always succeeds, rotating to a new blob. */
const okToken = (async () =>
  new Response(JSON.stringify({ access_token: "at", refresh_token: "rt2" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;

/** A refresh EVE permanently rejects → getFreshAccessToken returns "invalid". */
const deadToken = (async () =>
  new Response(JSON.stringify({ error: "invalid_grant" }), {
    status: 400,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;

/** A refresh that 500s → getFreshAccessToken returns "transient". */
const flakyToken = (async () =>
  new Response("upstream boom", { status: 500 })) as typeof fetch;

const list = (id: number, over: Partial<EsiAccessList> = {}): EsiAccessList => ({
  id,
  name: `List ${id}`,
  description: "",
  allowEveryone: false,
  characters: [],
  corporations: [],
  alliances: [],
  ...over,
});

type Calls = { lists: number; details: number[] };

function fakeEsi(opts: {
  ids?: number[];
  detail?: Record<number, EsiAccessList | EsiError>;
  listsError?: EsiError;
}): { esi: AccessListsEsi; calls: Calls } {
  const calls: Calls = { lists: 0, details: [] };
  const esi: AccessListsEsi = {
    getAccessLists: async () => {
      calls.lists++;
      if (opts.listsError) throw opts.listsError;
      return opts.ids ?? [];
    },
    getAccessList: async (_characterId, accessListId) => {
      calls.details.push(accessListId);
      const d = opts.detail?.[accessListId];
      if (d instanceof EsiError) throw d;
      return d ?? list(accessListId);
    },
    getUniverseNames: async (ids) =>
      ids.map((id) => ({ id, name: `Name ${id}`, category: "character" })),
  };
  return { esi, calls };
}

/** Seeds a healthy designated holder and returns its character id. */
async function seedHolder(opts: { scopes?: string[] } = {}): Promise<number> {
  const acc = await seedAccount(ctx.db, { tier: "member" });
  await seedCharacter(ctx.db, cfg, {
    id: HOLDER,
    accountId: acc.id,
    main: true,
    scopes: opts.scopes ?? [...cfg.eveSso.scopes, ACCESS_LISTS_SCOPE],
  });
  await ctx.db
    .insert(accessListHolder)
    .values({ id: 1, characterId: HOLDER, designatedBy: "admin" });
  return HOLDER;
}

async function watch(accessListId: number): Promise<void> {
  await ctx.db
    .insert(accessListWatch)
    .values({ accessListId, addedBy: "admin" });
}

async function snapshotOf(accessListId: number) {
  const [row] = await ctx.db
    .select()
    .from(accessListSnapshot)
    .where(eq(accessListSnapshot.accessListId, accessListId));
  return row;
}

async function entriesOf(accessListId: number) {
  return ctx.db
    .select()
    .from(accessListEntry)
    .where(eq(accessListEntry.accessListId, accessListId));
}

describe("runAccessListsJob", () => {
  it("no holder designated is ok, not a failure", async () => {
    const { esi, calls } = fakeEsi({});
    const result = await runAccessListsJob({
      db: ctx.db,
      cfg,
      esi,
      fetchImpl: okToken,
    });
    // An unconfigured optional feature must not paint /admin/sync red.
    expect(result.status).toBe("ok");
    expect(result.counts?.noHolder).toBe(1);
    expect(calls.lists).toBe(0);
  });

  it("a holder missing the scope is ok, and costs no ESI call", async () => {
    await seedHolder({ scopes: [...cfg.eveSso.scopes] });
    const { esi, calls } = fakeEsi({ ids: [7] });
    const result = await runAccessListsJob({
      db: ctx.db,
      cfg,
      esi,
      fetchImpl: okToken,
    });
    expect(result.status).toBe("ok");
    expect(result.counts?.scopeMissing).toBe(1);
    // Calling anyway would spend a token rotation to earn a certain 403.
    expect(calls.lists).toBe(0);
  });

  it("dry-run skips: getFreshAccessToken refuses before any refresh", async () => {
    await seedHolder();
    const dryCfg = testConfig({ SYNC_MODE: "dry-run" });
    const { esi, calls } = fakeEsi({ ids: [7] });
    const result = await runAccessListsJob({
      db: ctx.db,
      cfg: dryCfg,
      esi,
      fetchImpl: okToken,
    });
    expect(result.status).toBe("ok");
    expect(result.counts?.skipped).toBe(1);
    expect(calls.lists).toBe(0);
  });

  it("a transient token failure retries", async () => {
    await seedHolder();
    const { esi } = fakeEsi({ ids: [7] });
    await expect(
      runAccessListsJob({ db: ctx.db, cfg, esi, fetchImpl: flakyToken }),
    ).rejects.toThrow(JobRetryError);
  });

  it("no stored token fails without retrying", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, {
      id: HOLDER,
      accountId: acc.id,
      main: true,
      refreshToken: null,
      scopes: [...cfg.eveSso.scopes, ACCESS_LISTS_SCOPE],
    });
    await ctx.db
      .insert(accessListHolder)
      .values({ id: 1, characterId: HOLDER, designatedBy: "admin" });
    const { esi } = fakeEsi({ ids: [7] });
    const result = await runAccessListsJob({
      db: ctx.db,
      cfg,
      esi,
      fetchImpl: okToken,
    });
    expect(result.status).toBe("failed");
    expect(result.retry).toBeUndefined();
  });

  it("a permanently rejected token fails without retrying", async () => {
    await seedHolder();
    const { esi } = fakeEsi({ ids: [7] });
    const result = await runAccessListsJob({
      db: ctx.db,
      cfg,
      esi,
      fetchImpl: deadToken,
    });
    expect(result.status).toBe("failed");
    expect(result.retry).toBeUndefined();
  });

  it("reconciles the catalog, naming only the ids it has not cached", async () => {
    await seedHolder();
    await watch(7);
    // 999 is stale — the holder can no longer see it, so it must go. 8 is
    // already cached, so it must NOT cost a second detail call.
    await ctx.db.insert(accessListCatalog).values([
      { accessListId: 999, name: "Gone", observedByCharacterId: HOLDER },
      { accessListId: 8, name: "Cached", observedByCharacterId: HOLDER },
    ]);
    const { esi, calls } = fakeEsi({
      ids: [7, 8],
      detail: {
        7: list(7, {
          name: "Fleet",
          characters: [{ access: "read", id: 42 }],
          corporations: [{ access: "read", id: 900 }],
        }),
      },
    });
    const result = await runAccessListsJob({
      db: ctx.db,
      cfg,
      esi,
      fetchImpl: okToken,
    });
    expect(result.status).toBe("ok");
    expect(result.counts).toMatchObject({ lists: 2, watched: 1, read: 1, failed: 0 });
    const catalog = await ctx.db.select().from(accessListCatalog);
    expect(catalog.map((r) => [r.accessListId, r.name]).sort()).toEqual([
      [7, "Fleet"],
      [8, "Cached"],
    ]);
    // 7 was uncached AND watched, so it is named by discovery and then read;
    // 8 was cached, so it costs nothing. `named` counts only the naming call.
    expect(result.counts?.named).toBe(1);
    expect(calls.details).toEqual([7, 7]);
    const snap = await snapshotOf(7);
    expect(snap.readStatus).toBe("ok");
    expect(snap.name).toBe("Fleet");
    expect(snap.observedAt).not.toBeNull();
    const entries = await entriesOf(7);
    expect(entries.map((e) => [e.kind, e.entityId, e.access]).sort()).toEqual([
      ["character", 42, "read"],
      ["corporation", 900, "read"],
    ]);
  });

  it("leaves an unnameable list out of the catalog rather than inserting a placeholder", async () => {
    await seedHolder();
    const { esi } = fakeEsi({
      ids: [7],
      detail: { 7: new EsiError("boom", 500, "transient") },
    });
    const result = await runAccessListsJob({
      db: ctx.db,
      cfg,
      esi,
      fetchImpl: okToken,
    });
    // `name` is NOT NULL and a "?" row in the picker is worse than no row.
    expect(await ctx.db.select().from(accessListCatalog)).toEqual([]);
    expect(result.counts?.named).toBe(0);
  });

  it("a failed read leaves the prior entries intact and moves only lastAttemptAt", async () => {
    await seedHolder();
    await watch(7);
    const first = fakeEsi({
      ids: [7],
      detail: { 7: list(7, { characters: [{ access: "read", id: 42 }] }) },
    });
    await runAccessListsJob({ db: ctx.db, cfg, esi: first.esi, fetchImpl: okToken });
    const before = await snapshotOf(7);
    expect(before.observedAt).not.toBeNull();

    const second = fakeEsi({
      ids: [7],
      detail: { 7: new EsiError("boom", 500, "transient") },
    });
    const result = await runAccessListsJob({
      db: ctx.db,
      cfg,
      esi: second.esi,
      fetchImpl: okToken,
    });
    expect(result.counts?.failed).toBe(1);
    // Never remove on unknown state (src/jobs/wanderer.ts:41-54): a wiped
    // snapshot renders as "everyone lost access".
    const entries = await entriesOf(7);
    expect(entries.map((e) => e.entityId)).toEqual([42]);
    const after = await snapshotOf(7);
    // Two timestamps, never collapsed.
    expect(after.observedAt?.getTime()).toBe(before.observedAt?.getTime());
    expect(after.lastAttemptAt.getTime()).toBeGreaterThanOrEqual(
      before.lastAttemptAt.getTime(),
    );
    expect(after.readStatus).toBe("failed");
    expect(after.detail).toContain("boom");
  });

  it("a 403 is not_visible, not a token fault", async () => {
    await seedHolder();
    await watch(7);
    const { esi } = fakeEsi({
      ids: [7],
      detail: { 7: new EsiError("forbidden", 403, "permanent") },
    });
    const result = await runAccessListsJob({
      db: ctx.db,
      cfg,
      esi,
      fetchImpl: okToken,
    });
    // A list the holder simply cannot see is a normal state, not an error.
    expect(result.status).toBe("partial");
    const snap = await snapshotOf(7);
    expect(snap.readStatus).toBe("not_visible");
    expect(snap.observedAt).toBeNull();
  });

  it("a watched list discovery did not return is not_visible, with no detail call", async () => {
    await seedHolder();
    await watch(7);
    // Seed a good read first, so the test can prove the skip preserves it.
    const first = fakeEsi({
      ids: [7],
      detail: { 7: list(7, { characters: [{ access: "read", id: 42 }] }) },
    });
    await runAccessListsJob({ db: ctx.db, cfg, esi: first.esi, fetchImpl: okToken });
    const before = await snapshotOf(7);

    // The holder loses the list: discovery no longer returns it.
    const second = fakeEsi({ ids: [] });
    const result = await runAccessListsJob({
      db: ctx.db,
      cfg,
      esi: second.esi,
      fetchImpl: okToken,
    });

    expect(result.status).toBe("partial");
    // The point of the skip: no detail fetch at all. A 200 with empty
    // membership would otherwise be written as a real observation and wipe
    // the entries below.
    expect(second.calls.details).toEqual([]);
    const after = await snapshotOf(7);
    expect(after.readStatus).toBe("not_visible");
    expect(after.observedAt?.getTime()).toBe(before.observedAt?.getTime());
    expect((await entriesOf(7)).map((e) => e.entityId)).toEqual([42]);
  });

  it("discards the write when the holder changed mid-run", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, {
      id: 2000,
      accountId: acc.id,
      scopes: [...cfg.eveSso.scopes, ACCESS_LISTS_SCOPE],
    });
    await seedHolder();
    await watch(7);
    const { esi } = fakeEsi({ ids: [7, 8] });
    // Re-designate between the read and the write: getAccessLists is the last
    // point the job still believes HOLDER is designated.
    const racing: AccessListsEsi = {
      ...esi,
      getAccessLists: async (characterId, token) => {
        const ids = await esi.getAccessLists(characterId, token);
        await ctx.db
          .update(accessListHolder)
          .set({ characterId: 2000, designatedAt: new Date() })
          .where(eq(accessListHolder.id, 1));
        return ids;
      },
    };
    const result = await runAccessListsJob({
      db: ctx.db,
      cfg,
      esi: racing,
      fetchImpl: okToken,
    });
    // Outbox execution is at-least-once (src/worker/dispatcher.ts:124-136), so
    // a run started under holder A can land after B was designated. Different
    // holders see different lists — this is a discard, not a merge.
    expect(result.status).toBe("ok");
    expect(result.counts?.holderChanged).toBe(1);
    expect(await ctx.db.select().from(accessListCatalog)).toEqual([]);
  });

  it("resolves names for the ids it observed", async () => {
    await seedHolder();
    await watch(7);
    const { esi } = fakeEsi({
      ids: [7],
      detail: {
        7: list(7, {
          characters: [{ access: "read", id: 42 }],
          alliances: [{ access: "read", id: 99000001 }],
        }),
      },
    });
    const result = await runAccessListsJob({
      db: ctx.db,
      cfg,
      esi,
      fetchImpl: okToken,
    });
    expect(result.counts?.namesResolved).toBe(2);
  });
});
```

Add `JobRetryError` to the imports:

```ts
import { JobRetryError } from "@/services/sync-run";
```

- [ ] **Step 7: Run the test and watch it fail**

Run: `npx vitest run tests/access-lists-job.test.ts`
Expected: FAIL — every case errors at import with
`Failed to resolve import "@/jobs/access-lists"`, because the module does not
exist yet.

- [ ] **Step 8: Implement the guards — holder, scope, token**

Create `src/jobs/access-lists.ts` with the imports and the first three of the
job's six numbered steps:

```ts
import { eq, notInArray } from "drizzle-orm";
import type { Config } from "@/config";
import type { Db } from "@/db";
import {
  accessListCatalog,
  accessListEntry,
  accessListHolder,
  accessListSnapshot,
  character,
} from "@/db/schema";
import {
  ACCESS_LISTS_SCOPE,
  EsiError,
  type AccessListsEsi,
  type EsiAccessList,
} from "@/lib/esi/client";
import { getHolder, getWatchedListIds } from "@/services/access-lists";
import { resolveEntityNames } from "@/services/entity-names";
import { runJob, type JobResult } from "@/services/sync-run";
import { getFreshAccessToken } from "@/services/tokens";

type Counts = {
  lists: number;
  watched: number;
  read: number;
  failed: number;
  skipped: number;
  noHolder: number;
  scopeMissing: number;
  holderChanged: number;
  named: number;
  namesResolved: number;
};

export async function runAccessListsJob(deps: {
  db: Db;
  cfg: Config;
  esi: AccessListsEsi;
  fetchImpl?: typeof fetch;
}): Promise<JobResult> {
  const { db, cfg, esi } = deps;
  return runJob(db, "access-lists", async () => {
    const counts: Counts = {
      lists: 0,
      watched: 0,
      read: 0,
      failed: 0,
      skipped: 0,
      noHolder: 0,
      scopeMissing: 0,
      holderChanged: 0,
      named: 0,
      namesResolved: 0,
    };

    // 1. No holder. An unconfigured optional feature must not paint
    //    /admin/sync red — the monitor page explains the missing designation.
    const holder = await getHolder(db);
    if (!holder) {
      counts.noHolder = 1;
      return { status: "ok", counts };
    }

    const [row] = await db
      .select({
        id: character.id,
        refreshTokenEnc: character.refreshTokenEnc,
        tokenStatus: character.tokenStatus,
        scopes: character.scopes,
      })
      .from(character)
      .where(eq(character.id, holder.characterId));
    if (!row) {
      // The holder FK cascades, so a missing character row means the
      // designation was deleted concurrently. Same state as no holder.
      counts.noHolder = 1;
      return { status: "ok", counts };
    }

    // 2. Scope, from the PERSISTED grant and before any ESI call: calling
    //    anyway would spend a refresh-token rotation to earn a certain 403.
    if (!row.scopes.includes(ACCESS_LISTS_SCOPE)) {
      counts.scopeMissing = 1;
      return { status: "ok", counts };
    }

    // 3. Token. getFreshAccessToken has FOUR outcomes and performs its own
    //    invalidation CAS internally (src/services/tokens.ts:92-98,126-133),
    //    so this job must not repeat it.
    const token = await getFreshAccessToken(
      db,
      cfg,
      {
        id: row.id,
        refreshTokenEnc: row.refreshTokenEnc,
        tokenStatus: row.tokenStatus,
      },
      deps.fetchImpl,
    );
    if (!token.ok) {
      if (token.reason === "dry_run") {
        counts.skipped = 1;
        return { status: "ok", counts };
      }
      if (token.reason === "transient") {
        return {
          status: "failed",
          errorSummary: `token refresh failed: ${token.detail ?? "transient"}`,
          counts,
          retry: true,
        };
      }
      // no_token / invalid: no read can succeed until the character
      // re-authenticates. The page renders the dark-monitor state; retrying
      // would only loop.
      return {
        status: "failed",
        errorSummary: `holder token ${token.reason}`,
        counts,
      };
    }

    return runReads({ db, esi, counts, characterId: row.id, accessToken: token.accessToken });
  });
}
```

- [ ] **Step 9: Implement discovery under the stale-holder guard**

Append to `src/jobs/access-lists.ts`:

```ts
/**
 * Whether `characterId` is STILL the designated holder, read inside the caller's
 * transaction.
 *
 * Outbox execution is at-least-once (src/worker/dispatcher.ts:124-136), so a
 * run that started under holder A can still be mid-flight when an admin
 * designates B — and A's late write would reconcile the catalog against the
 * set of lists *A* can see, discarding B's. This is the same
 * compare-and-swap shape the token code uses to discard stale concurrent
 * decisions (src/services/tokens.ts:100-115). Different holders legitimately
 * see different lists, so a miss is a discard, not a merge.
 */
async function stillHolder(tx: Dbx, characterId: number): Promise<boolean> {
  const [row] = await tx
    .select({ characterId: accessListHolder.characterId })
    .from(accessListHolder)
    .where(eq(accessListHolder.id, 1));
  return row?.characterId === characterId;
}

async function runReads(args: {
  db: Db;
  esi: AccessListsEsi;
  counts: Counts;
  characterId: number;
  accessToken: string;
}): Promise<JobResult> {
  const { db, esi, counts, characterId, accessToken } = args;
  const errors: string[] = [];
  let anyTransient = false;

  // 4. Discovery. /access-lists returns ids ONLY, so every name costs its own
  //    detail call. `access_list_catalog` is the cache of those names, which is
  //    why this reconciles against the discovered set instead of deleting and
  //    rebuilding: a rebuild would throw away every cached name and re-buy the
  //    whole set every run. The name column is NOT NULL, and an id the job
  //    cannot name is not worth showing in a picker.
  let discovered: number[];
  try {
    discovered = await esi.getAccessLists(characterId, accessToken);
  } catch (err) {
    const msg = `list discovery failed: ${message(err)}`;
    const transient = err instanceof EsiError ? err.kind === "transient" : true;
    return { status: "failed", errorSummary: msg, counts, retry: transient || undefined };
  }
  counts.lists = discovered.length;

  const cached = new Map(
    (await db.select().from(accessListCatalog)).map((r) => [r.accessListId, r.name]),
  );
  const named: { accessListId: number; name: string; observedByCharacterId: number }[] = [];
  for (const accessListId of discovered) {
    const hit = cached.get(accessListId);
    if (hit !== undefined) {
      named.push({ accessListId, name: hit, observedByCharacterId: characterId });
      continue;
    }
    try {
      const detail = await esi.getAccessList(characterId, accessListId, accessToken);
      counts.named++;
      named.push({ accessListId, name: detail.name, observedByCharacterId: characterId });
    } catch (err) {
      // Left out of the catalog rather than inserted with a placeholder: the
      // next run retries it, and a row named "?" in the picker is worse than a
      // row that is not there yet.
      errors.push(`naming ${accessListId}: ${message(err)}`);
      if (err instanceof EsiError ? err.kind === "transient" : true) anyTransient = true;
    }
  }

  const wrote = await db.transaction(async (tx) => {
    if (!(await stillHolder(tx, characterId))) return false;
    // Reconcile, not replace: drop what this holder can no longer see, keep
    // and refresh the rest.
    const keep = named.map((r) => r.accessListId);
    await tx
      .delete(accessListCatalog)
      .where(keep.length > 0 ? notInArray(accessListCatalog.accessListId, keep) : undefined);
    if (named.length > 0) {
      await tx
        .insert(accessListCatalog)
        .values(named)
        .onConflictDoUpdate({
          target: accessListCatalog.accessListId,
          set: { observedByCharacterId: characterId },
        });
    }
    return true;
  });
  if (!wrote) {
    counts.holderChanged = 1;
    // The next run, under the new holder, produces the correct state.
    return { status: "ok", counts };
  }

  return readWatched({
    db,
    esi,
    counts,
    characterId,
    accessToken,
    errors,
    anyTransient,
    discovered,
  });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

Add `Dbx` to the db import:

```ts
import type { Db, Dbx } from "@/db";
```

- [ ] **Step 10: Implement the per-list read, with two timestamps**

Append to `src/jobs/access-lists.ts`:

```ts
function entryRows(accessListId: number, detail: EsiAccessList) {
  return [
    ...detail.characters.map((m) => ({ kind: "character" as const, ...m })),
    ...detail.corporations.map((m) => ({ kind: "corporation" as const, ...m })),
    ...detail.alliances.map((m) => ({ kind: "alliance" as const, ...m })),
  ].map((m) => ({
    accessListId,
    kind: m.kind,
    entityId: m.id,
    access: m.access,
  }));
}

/**
 * Writes the ATTEMPT columns only, under the stale-holder guard. Returns true
 * if the holder changed mid-run, in which case the caller abandons the run.
 * observedAt and the entries are deliberately untouched: "never remove on
 * unknown state" (src/jobs/wanderer.ts:41-54) — a wiped snapshot renders as
 * "everyone lost access". Two timestamps, never collapsed.
 */
async function writeAttempt(
  db: Db,
  characterId: number,
  accessListId: number,
  attempt: { lastAttemptAt: Date; readStatus: "not_visible" | "failed"; detail: string },
): Promise<boolean> {
  // Without the guard a superseded holder's failure overwrites the current
  // holder's status, and the page shows "not visible" for a list the real
  // holder can read.
  return db.transaction(async (tx) => {
    if (!(await stillHolder(tx, characterId))) return true;
    await tx
      .insert(accessListSnapshot)
      .values({ accessListId, observedByCharacterId: characterId, ...attempt })
      .onConflictDoUpdate({
        target: accessListSnapshot.accessListId,
        set: attempt,
      });
    return false;
  });
}

async function readWatched(args: {
  db: Db;
  esi: AccessListsEsi;
  counts: Counts;
  characterId: number;
  accessToken: string;
  errors: string[];
  anyTransient: boolean;
  discovered: number[];
}): Promise<JobResult> {
  const { db, esi, counts, characterId, accessToken, errors } = args;
  let anyTransient = args.anyTransient;
  const watched = await getWatchedListIds(db);
  counts.watched = watched.length;
  const observedIds = new Set<number>();
  const discoveredSet = new Set(args.discovered);

  // 5. Per watched list.
  for (const accessListId of watched) {
    // Discovery is the authority on what this holder can see. A watched id it
    // did not return is recorded not-visible WITHOUT a detail fetch — the
    // fetch is not just wasteful, it is unsafe: if ESI answers 200 with empty
    // membership for a list the holder lost, that is indistinguishable from
    // "an admin removed everyone" and would be written as a real observation,
    // wiping the last good entries. Skipping leaves them intact.
    if (!discoveredSet.has(accessListId)) {
      counts.failed++;
      errors.push(`${accessListId}: not in this holder's access lists`);
      const stale = await writeAttempt(db, characterId, accessListId, {
        lastAttemptAt: new Date(),
        readStatus: "not_visible",
        detail: "Not among the lists this character can see.",
      });
      if (stale) {
        counts.holderChanged = 1;
        return { status: "ok", counts };
      }
      continue;
    }

    let detail: EsiAccessList;
    try {
      detail = await esi.getAccessList(characterId, accessListId, accessToken);
    } catch (err) {
      counts.failed++;
      // A list discovery DID return can still fail: an admin can revoke
      // between the two calls. 403 and 404 both mean "no longer visible" — a
      // normal state, not a token fault — classified the way contacts
      // classifies its own (src/jobs/contacts.ts:224-240). Both are accepted
      // because which one ESI returns is not worth a round trip to find out,
      // and treating either as a fault would flag a benign permission change
      // as a broken token.
      const notVisible =
        err instanceof EsiError && (err.status === 403 || err.status === 404);
      if (!notVisible && (err instanceof EsiError ? err.kind === "transient" : true)) {
        anyTransient = true;
      }
      errors.push(`${accessListId}: ${message(err)}`);
      const stale = await writeAttempt(db, characterId, accessListId, {
        lastAttemptAt: new Date(),
        readStatus: notVisible ? "not_visible" : "failed",
        detail: message(err).slice(0, 500),
      });
      if (stale) {
        counts.holderChanged = 1;
        return { status: "ok", counts };
      }
      continue;
    }

    const now = new Date();
    const skipped = await db.transaction(async (tx) => {
      if (!(await stillHolder(tx, characterId))) return true;
      const set = {
        observedAt: now,
        lastAttemptAt: now,
        readStatus: "ok" as const,
        observedByCharacterId: characterId,
        name: detail.name,
        description: detail.description,
        allowEveryone: detail.allowEveryone,
        detail: null,
      };
      await tx
        .insert(accessListSnapshot)
        .values({ accessListId, ...set })
        .onConflictDoUpdate({ target: accessListSnapshot.accessListId, set });
      // Replace THIS list's entries only, in the same transaction as its
      // snapshot: a reader must never see a snapshot beside another read's rows.
      await tx.delete(accessListEntry).where(eq(accessListEntry.accessListId, accessListId));
      const rows = entryRows(accessListId, detail);
      if (rows.length > 0) await tx.insert(accessListEntry).values(rows);
      // A watched list's detail read is the freshest name anyone has, so it
      // refreshes the catalog cache. Unwatched lists keep the name they were
      // discovered with until someone watches them — the cost of not buying a
      // detail call per list per run.
      await tx
        .update(accessListCatalog)
        .set({ name: detail.name })
        .where(eq(accessListCatalog.accessListId, accessListId));
      return false;
    });
    if (skipped) {
      counts.holderChanged = 1;
      return { status: "ok", counts };
    }
    counts.read++;
    for (const r of entryRows(accessListId, detail)) observedIds.add(r.entityId);
  }

  // 6. Names, last and best-effort: resolveEntityNames never throws, and
  //    unresolved ids render bare rather than failing the run.
  const names = await resolveEntityNames(db, esi, [...observedIds]);
  counts.namesResolved = names.size;

  if (counts.failed > 0) {
    return {
      status: "partial",
      errorSummary: errors.slice(0, 5).join("; "),
      counts,
      retry: anyTransient || undefined,
    };
  }
  return { status: "ok", counts };
}
```

- [ ] **Step 11: Run the test and watch it pass**

Run: `npx vitest run tests/access-lists-job.test.ts`
Expected: PASS, all thirteen cases.

If the "failed read leaves prior entries intact" case fails on `lastAttemptAt`
not advancing, the two runs landed inside the same millisecond — the assertion
is `toBeGreaterThanOrEqual` for exactly that reason; a strict `>` there would
be flaky.

- [ ] **Step 12: Typecheck and the full suite**

Run: `npm run typecheck`
Expected: no errors. This is where Step 4's handler edit is proved — until
Step 8 the map entry referenced a module that did not exist.

Run: `npx vitest run tests/dispatcher.test.ts tests/access-lists-job.test.ts`
Expected: PASS.

Run: `npm run format:check`
Expected: no files listed.

- [ ] **Step 13: Commit**

One commit for the whole task — the registration edits from Steps 2–4 land
here, with the module they name.

```bash
git add src/core/schedules.ts src/worker/queues.ts src/worker/handlers.ts \
  src/jobs/access-lists.ts tests/access-lists-job.test.ts
git commit -m "feat(jobs): read designated-holder access lists into snapshots"
```

---

### Task 8: Opt-in scope grant flow

**Files:**
- Modify: `src/lib/esi/sso.ts:27-41` (`buildEveAuthorizeUrl`)
- Modify: `src/app/auth/eve/link/route.ts:8-18` (`GET`)
- Test: `tests/eve-sso.test.ts:34-50` (the existing `buildEveAuthorizeUrl` describe)

`tests/sso.test.ts` does **not** exist. The existing tests for
`buildEveAuthorizeUrl` live in `tests/eve-sso.test.ts`, which builds its own
`cfg` via `loadConfig` with `EVE_SSO_SCOPES: "esi-characters.read_contacts.v1"`
(`tests/eve-sso.test.ts:10-32`) — a single-scope config, which is convenient
for asserting the union.

**Interfaces:**
- Consumes: `ACCESS_LISTS_SCOPE` from `@/lib/esi/client` (Task 2)
- Produces:
  ```ts
  export function buildEveAuthorizeUrl(
    cfg: Config,
    state: string,
    codeChallenge: string,
    extraScopes: string[] = [],
  ): string;
  ```
  and `/auth/eve/link?grant=access-lists`, which requests
  `cfg.eveSso.scopes ∪ [ACCESS_LISTS_SCOPE]`.

**What this flow can and cannot promise.** The authorize URL is constructed
**before** EVE's own character picker runs, so at the moment
`/auth/eve/link` builds the scope string there is no "the character" yet —
identity is learned only from the callback JWT
(`src/app/auth/eve/link/route.ts:8-17`, `src/app/auth/eve/callback/route.ts:76-83`).
The grant therefore attaches to whichever character the operator happens to
pick at the picker. This route cannot target a specific character, and no
amount of state-passing would fix it, since the member can pick a different
character regardless. The monitor page's job is to **detect** the resulting
scope state, not to guarantee it.

Two stated limitations follow, and neither is a bug to fix here:
- The scope can be **silently dropped** by an ordinary later re-auth — every
  `<a href="/auth/eve/link">` on the account page requests `cfg.eveSso.scopes`
  alone. The page announces the loss and asks for a re-grant (spec, *The scope
  is opt-in, and its loss is made visible*).
- The flow returns to `/account`, not to `/admin/access-lists`. A `returnTo`
  would touch the OAuth state flow, which CLAUDE.md names as a stop-and-ask
  surface, so it is excluded.

Nothing else changes. The callback already stores exactly what EVE granted into
`character.scopes`, and token-health checks "nothing missing" rather than set
equality — Step 5 verifies that second claim by reading the job rather than
assuming it.

- [ ] **Step 1: Write the failing test**

Add to the existing `describe("buildEveAuthorizeUrl", ...)` in
`tests/eve-sso.test.ts`, after the "contains all required params" case:

```ts
  it("unions extraScopes with the configured set, de-duplicated", () => {
    const url = new URL(
      buildEveAuthorizeUrl(cfg, "st4te", "ch4llenge", [
        "esi-access.read_lists.v1",
        "esi-characters.read_contacts.v1", // already configured
      ]),
    );
    expect(url.searchParams.get("scope")).toBe(
      "esi-characters.read_contacts.v1 esi-access.read_lists.v1",
    );
  });

  it("omitting extraScopes is unchanged", () => {
    const url = new URL(buildEveAuthorizeUrl(cfg, "st4te", "ch4llenge"));
    expect(url.searchParams.get("scope")).toBe("esi-characters.read_contacts.v1");
  });
```

The expected order is configured-scopes-first, then the extras in the order
given: the de-duplication runs over the concatenation, so a repeated extra
keeps its first (configured) position.

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/eve-sso.test.ts -t "unions extraScopes"`
Expected: FAIL — TypeScript rejects the 4th argument
(`Expected 3 arguments, but got 4`); under vitest's transpile-only run the
extra argument is ignored and the assertion fails with
`expected 'esi-characters.read_contacts.v1' to be 'esi-characters.read_contacts.v1 esi-access.read_lists.v1'`.

- [ ] **Step 3: Implement the parameter**

`src/lib/esi/sso.ts`:

```ts
/**
 * `extraScopes` is unioned with the configured set rather than replacing it:
 * the callback stores whatever EVE grants, so a request that dropped the
 * standing scopes would silently downgrade the character.
 *
 * This CANNOT target a specific character. EVE's picker runs after this URL is
 * built, so the grant attaches to whichever character the operator chooses —
 * identity is learned only from the callback JWT. Callers detect the resulting
 * scope state; they cannot guarantee it.
 */
export function buildEveAuthorizeUrl(
  cfg: Config,
  state: string,
  codeChallenge: string,
  extraScopes: string[] = [],
): string {
  const url = new URL(AUTHORIZE_URL);
  const scopes = [...new Set([...cfg.eveSso.scopes, ...extraScopes])];
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", `${cfg.appBaseUrl}/auth/eve/callback`);
  url.searchParams.set("client_id", cfg.eveSso.clientId);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run tests/eve-sso.test.ts`
Expected: PASS — including the pre-existing "contains all required params"
case, which asserts the bare-call scope string is unchanged.

- [ ] **Step 5: Verify that an extra scope does not trip token-health**

Read `src/jobs/token-health.ts` around lines 103-105 and confirm the check is
`cfg.eveSso.scopes.filter((s) => !identity.scopes.includes(s))` with
`covered = missingScopes.length === 0` — i.e. "nothing missing", not set
equality. A character carrying an **extra** scope therefore stays `valid`, so
this flow needs no token-health change. This is a read, not an edit: if the
check turns out to be set equality, stop and raise it, because adding the scope
to `EVE_SSO_SCOPES` is then the only workable design and that flips every
character to `needs_reauth` at the next 03:00 UTC run.

Run: `grep -n "missingScopes\|covered" src/jobs/token-health.ts`
Expected: the filter-and-length-zero shape above.

- [ ] **Step 6: Accept `?grant=access-lists` on the link route**

`src/app/auth/eve/link/route.ts`, replacing the file body:

```ts
import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { ACCESS_LISTS_SCOPE } from "@/lib/esi/client";
import { buildEveAuthorizeUrl } from "@/lib/esi/sso";
import { getRequestAccount } from "@/lib/request-session";
import { createOauthTransaction } from "@/services/oauth-tx";

export async function GET(req: NextRequest) {
  const cfg = getConfig();
  const sess = await getRequestAccount(req);
  if (!sess) return NextResponse.redirect(new URL("/login", cfg.appBaseUrl));
  const tx = await createOauthTransaction(getDb(), {
    intent: "link-character",
    sessionId: sess.sessionId,
    accountId: sess.accountId,
  });
  // Opt-in only: esi-access.read_lists.v1 is deliberately NOT in
  // EVE_SSO_SCOPES, because adding it there would flip every character to
  // needs_reauth at the next token-health run. An exact literal, not a
  // free-form scope parameter — the query string is attacker-controllable and
  // must not be able to widen what we ask EVE for.
  const extraScopes =
    req.nextUrl.searchParams.get("grant") === "access-lists" ? [ACCESS_LISTS_SCOPE] : [];
  return NextResponse.redirect(
    buildEveAuthorizeUrl(cfg, tx.state, tx.codeChallenge, extraScopes),
  );
}
```

The `intent` stays `link-character` and the callback is untouched: it stores
granted scopes exactly as today, so designation remains a separate explicit
admin action (spec, *The OAuth state flow is not touched*).

- [ ] **Step 7: Typecheck and the surrounding suites**

Run: `npm run typecheck`
Expected: no errors. `src/app/auth/eve/login/route.ts:10` calls
`buildEveAuthorizeUrl` with three arguments and is unaffected by the defaulted
parameter — the login flow must keep asking for the configured set only.

Run: `npx vitest run tests/eve-sso.test.ts tests/token-health-job.test.ts`
Expected: PASS.

- [ ] **Step 8: Format check**

Run: `npm run format:check`
Expected: no files listed.

- [ ] **Step 9: Commit**

```bash
git add src/lib/esi/sso.ts src/app/auth/eve/link/route.ts tests/eve-sso.test.ts
git commit -m "feat(auth): allow an opt-in access-lists scope grant on /auth/eve/link"
```

---

### Task 9: The page's pure view module

Everything the page decides that does not need JSX lives here, so the seven
states, their tone and their remedies are unit-testable without seeding a
database and driving a browser. `src/app/admin/sync/view.ts` is the model, and
`tests/sync-view.test.ts` is the model for the test.

**Files:**

- Create: `src/app/admin/access-lists/view.ts`
- Test: `tests/access-lists-view.test.ts`

**Interfaces:**

- Consumes: `Tone` (`@/app/_components/ui`), `ACCESS_LISTS_SCOPE`
  (`@/lib/esi/client`), `AccessListComparison` / `BroadGrant`
  (`@/core/access-list-compare`), `AccessListReadStatus` (the Drizzle enum's
  inferred type, `@/db/schema`).
- Produces, for Task 10 and Task 11:

```ts
export type HolderRef = { characterId: number; name: string };
export type MonitorInput = {
  holder: {
    characterId: number;
    name: string;
    scopes: string[];
    tokenStatus: "valid" | "invalid" | "needs_reauth" | "missing";
  } | null;
  viewerHasScope: boolean;
  catalogSize: number;
};
export type MonitorState =
  | { kind: "grant-needed" }
  | { kind: "designate-needed" }
  | { kind: "scope-dropped"; holder: HolderRef }
  | { kind: "holder-needs-reauth"; holder: HolderRef }
  | { kind: "holder-no-token"; holder: HolderRef; tokenStatus: "invalid" | "missing" }
  | { kind: "catalog-empty"; holder: HolderRef }
  | { kind: "normal"; holder: HolderRef };
export function monitorState(input: MonitorInput): MonitorState;
export function monitorSentence(state: MonitorState): string;
export type Remedy =
  | { kind: "link"; label: string; href: string }
  | { kind: "designate" }
  | { kind: "check-now" };
export function monitorRemedy(state: MonitorState): Remedy;
export function showsObservations(state: MonitorState): boolean;
export type WatchedRow = {
  accessListId: number;
  name: string | null;
  readStatus: AccessListReadStatus | null;
  observedAt: Date | null;
  allowEveryone: boolean | null;
  missingAccess: number;
  nonMembers: number;
  broadGrants: number;
};
export function rowTone(row: WatchedRow): Tone;
export function rowSummary(row: WatchedRow): string;
export function rowHasDetail(row: WatchedRow): boolean;
export function doneNotice(done: string | undefined, at: string | undefined): string;
```

- [ ] **Step 1: Write the failing test — the seven states in priority order**

Create `tests/access-lists-view.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ACCESS_LISTS_SCOPE } from "@/lib/esi/client";
import {
  doneNotice,
  monitorRemedy,
  monitorSentence,
  monitorState,
  rowHasDetail,
  rowSummary,
  rowTone,
  showsObservations,
  type MonitorInput,
  type WatchedRow,
} from "@/app/admin/access-lists/view";

const HOLDER = {
  characterId: 91_000_001,
  name: "Vela Kaine",
  scopes: [ACCESS_LISTS_SCOPE],
  tokenStatus: "valid" as const,
};

function input(over: Partial<MonitorInput> = {}): MonitorInput {
  return { holder: HOLDER, viewerHasScope: true, catalogSize: 3, ...over };
}

describe("monitorState", () => {
  it("1: no holder and the viewer lacks the scope asks for the grant first", () => {
    const s = monitorState(input({ holder: null, viewerHasScope: false }));
    expect(s.kind).toBe("grant-needed");
    expect(monitorRemedy(s)).toEqual({
      kind: "link",
      label: "Grant access",
      href: "/auth/eve/link?grant=access-lists",
    });
  });

  it("2: no holder but the viewer already granted it asks for designation", () => {
    const s = monitorState(input({ holder: null, viewerHasScope: true }));
    expect(s.kind).toBe("designate-needed");
    expect(monitorRemedy(s)).toEqual({ kind: "designate" });
  });

  it("3: a holder whose scope was dropped by an ordinary re-auth asks to re-grant", () => {
    const s = monitorState(input({ holder: { ...HOLDER, scopes: [] } }));
    expect(s).toEqual({
      kind: "scope-dropped",
      holder: { characterId: HOLDER.characterId, name: HOLDER.name },
    });
    expect(monitorRemedy(s)).toEqual({
      kind: "link",
      label: "Re-grant access",
      href: "/auth/eve/link?grant=access-lists",
    });
    // The scope is what is missing, so the remedy must be the granting link,
    // not the plain re-auth — the plain one would drop the scope again.
    expect(monitorSentence(s)).toContain("Vela Kaine");
    expect(monitorSentence(s)).toContain("no reads are happening");
  });

  it("4 and 5 are distinct states with distinct remedies", () => {
    const reauth = monitorState(
      input({ holder: { ...HOLDER, tokenStatus: "needs_reauth" } }),
    );
    expect(reauth.kind).toBe("holder-needs-reauth");
    expect(monitorRemedy(reauth)).toEqual({
      kind: "link",
      label: "Re-authenticate",
      href: "/auth/eve/link",
    });

    for (const tokenStatus of ["invalid", "missing"] as const) {
      const dead = monitorState(input({ holder: { ...HOLDER, tokenStatus } }));
      expect(dead).toEqual({
        kind: "holder-no-token",
        holder: { characterId: HOLDER.characterId, name: HOLDER.name },
        tokenStatus,
      });
      expect(monitorRemedy(dead)).toEqual({
        kind: "link",
        label: "Add this character again",
        href: "/auth/eve/link",
      });
    }

    // The sentences differ, because the two faults are not the same fault:
    // `needs_reauth` is a stored token whose grant went stale, `missing` is no
    // stored token at all. Same URL, different explanation of why you are at it.
    const missing = monitorState(input({ holder: { ...HOLDER, tokenStatus: "missing" } }));
    const invalid = monitorState(input({ holder: { ...HOLDER, tokenStatus: "invalid" } }));
    expect(monitorSentence(missing)).toContain("no stored token");
    expect(monitorSentence(invalid)).toContain("stopped working");
    expect(monitorSentence(reauth)).not.toBe(monitorSentence(missing));
  });

  it("a dropped scope outranks a bad token: fixing the token alone would not help", () => {
    const s = monitorState(
      input({ holder: { ...HOLDER, scopes: [], tokenStatus: "needs_reauth" } }),
    );
    expect(s.kind).toBe("scope-dropped");
  });

  it("6: a healthy holder with an empty catalog offers Check now", () => {
    const s = monitorState(input({ catalogSize: 0 }));
    expect(s.kind).toBe("catalog-empty");
    expect(monitorRemedy(s)).toEqual({ kind: "check-now" });
  });

  it("7: a healthy holder with a catalog is normal", () => {
    expect(monitorState(input()).kind).toBe("normal");
  });

  it("every dark-monitor state still shows the last observations", () => {
    // States 3-6 render the last successful observation beside the problem:
    // a stale answer plus its date beats a blank page. Only the two no-holder
    // states have nothing to show.
    for (const s of [
      monitorState(input({ holder: { ...HOLDER, scopes: [] } })),
      monitorState(input({ holder: { ...HOLDER, tokenStatus: "needs_reauth" } })),
      monitorState(input({ holder: { ...HOLDER, tokenStatus: "invalid" } })),
      monitorState(input({ catalogSize: 0 })),
      monitorState(input()),
    ]) {
      expect(showsObservations(s)).toBe(true);
    }
    expect(showsObservations(monitorState(input({ holder: null })))).toBe(false);
    expect(
      showsObservations(monitorState(input({ holder: null, viewerHasScope: false }))),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Extend the test with the row tone, summary and expand rules**

Append to `tests/access-lists-view.test.ts`:

```ts
function row(over: Partial<WatchedRow> = {}): WatchedRow {
  return {
    accessListId: 4001,
    name: "Fleet staging",
    readStatus: "ok",
    observedAt: new Date("2026-08-09T10:00:00.000Z"),
    allowEveryone: false,
    missingAccess: 0,
    nonMembers: 0,
    broadGrants: 0,
    ...over,
  };
}

describe("rowTone", () => {
  it("a clean list is ok", () => {
    expect(rowTone(row())).toBe("ok");
  });

  it("drift is warn, never bad — bad is reserved for destructive acts", () => {
    expect(rowTone(row({ missingAccess: 3 }))).toBe("warn");
    expect(rowTone(row({ nonMembers: 2 }))).toBe("warn");
    expect(rowTone(row({ allowEveryone: true }))).toBe("warn");
    expect(rowTone(row({ readStatus: "failed" }))).toBe("warn");
    expect(rowTone(row({ readStatus: "not_visible" }))).toBe("warn");
  });

  it("never bad, for any input this type admits", () => {
    for (const r of [
      row({ missingAccess: 99, nonMembers: 99, allowEveryone: true, readStatus: "failed" }),
      row({ readStatus: null, observedAt: null }),
    ]) {
      expect(rowTone(r)).not.toBe("bad");
    }
  });

  it("a watched list the job has not reached yet is off, not warn", () => {
    // Same argument `sync/view.ts` makes for `never`: a list added to the
    // watchlist a minute ago has not failed at anything.
    expect(rowTone(row({ readStatus: null, observedAt: null }))).toBe("off");
  });
});

describe("rowSummary", () => {
  it("states allow_everyone in its own words, not as zero discrepancies", () => {
    const text = rowSummary(row({ allowEveryone: true }));
    expect(text).toContain("everyone");
    expect(text).not.toContain("in sync");
  });

  it("counts both buckets", () => {
    expect(rowSummary(row({ missingAccess: 2, nonMembers: 1 }))).toBe(
      "2 missing access · 1 has access, not a member",
    );
  });

  it("singularizes", () => {
    expect(rowSummary(row({ missingAccess: 1 }))).toBe("1 missing access");
  });

  it("names the read failure rather than the drift beneath it", () => {
    expect(rowSummary(row({ readStatus: "not_visible" }))).toBe("not visible to holder");
    expect(rowSummary(row({ readStatus: "failed" }))).toBe("read failed");
    expect(rowSummary(row({ readStatus: null, observedAt: null }))).toBe("not read yet");
  });
});

describe("rowHasDetail", () => {
  it("only rows with something to report expand", () => {
    expect(rowHasDetail(row())).toBe(false);
    expect(rowHasDetail(row({ readStatus: null, observedAt: null }))).toBe(false);
    expect(rowHasDetail(row({ missingAccess: 1 }))).toBe(true);
    expect(rowHasDetail(row({ nonMembers: 1 }))).toBe(true);
    expect(rowHasDetail(row({ broadGrants: 1 }))).toBe(true);
    expect(rowHasDetail(row({ allowEveryone: true }))).toBe(true);
    expect(rowHasDetail(row({ readStatus: "failed" }))).toBe(true);
  });
});

describe("doneNotice", () => {
  it("stamps the press so a second identical one still announces", () => {
    const text = doneNotice("check", "1786500000000");
    expect(text).toContain("Check queued");
    expect(text).toMatch(/\d\d:\d\d:\d\d\.\d\d\d UTC/);
  });

  it("drops an unparseable stamp rather than echoing it", () => {
    expect(doneNotice("check", "<script>")).toBe(
      "Check queued. Reload this page once the worker has run.",
    );
  });

  it("returns nothing for an unknown marker", () => {
    expect(doneNotice("nope", "1786500000000")).toBe("");
    expect(doneNotice(undefined, undefined)).toBe("");
  });
});
```

- [ ] **Step 3: Run the test and watch it fail**

Run: `npx vitest run tests/access-lists-view.test.ts`
Expected: FAIL — `Failed to resolve import "@/app/admin/access-lists/view"`.

- [ ] **Step 4: Implement `view.ts`**

Create `src/app/admin/access-lists/view.ts`:

```ts
import type { Tone } from "@/app/_components/ui";
import type { AccessListReadStatus } from "@/db/schema";
import { ACCESS_LISTS_SCOPE } from "@/lib/esi/client";

/**
 * The pure decisions behind `/admin/access-lists`, split from `page.tsx` for
 * the same reason `admin/sync/view.ts` is: the seven states this page has to
 * distinguish are a priority-ordered cascade, and the only way to exercise a
 * cascade living inside a server component is to seed a database and drive a
 * browser. Three of the seven (the dark-monitor states) are the ones most
 * likely to be reached in production and the least likely to be reached by
 * hand in review, which is precisely the shape that wants a cheap test each.
 */

export type HolderRef = { characterId: number; name: string };

export type MonitorInput = {
  /** The designated holder, joined to its character row, or null. */
  holder: {
    characterId: number;
    name: string;
    scopes: string[];
    tokenStatus: "valid" | "invalid" | "needs_reauth" | "missing";
  } | null;
  /** Whether the *viewing admin's* main character already granted the scope —
   *  what decides between "Grant access" and "Designate as holder". */
  viewerHasScope: boolean;
  catalogSize: number;
};

export type MonitorState =
  | { kind: "grant-needed" }
  | { kind: "designate-needed" }
  | { kind: "scope-dropped"; holder: HolderRef }
  | { kind: "holder-needs-reauth"; holder: HolderRef }
  | { kind: "holder-no-token"; holder: HolderRef; tokenStatus: "invalid" | "missing" }
  | { kind: "catalog-empty"; holder: HolderRef }
  | { kind: "normal"; holder: HolderRef };

/**
 * The cascade, in the spec's priority order. Order is the whole content of
 * this function, so it is worth saying what each precedence buys:
 *
 * The scope check precedes the token check because the two faults are not
 * independent — a holder that re-authenticated through the ordinary link has
 * a perfectly `valid` token AND no ACL scope, and the plain re-auth link this
 * page would offer for a token fault is the exact action that dropped the
 * scope. Offering it first would send an admin round the loop that caused the
 * problem. When both are wrong, the granting link fixes both at once.
 *
 * The catalog check comes last of the faults because an empty catalog under a
 * healthy holder is not a fault at all: it is a holder the job has not run for
 * yet, and its one remedy is the button that runs it.
 */
export function monitorState(input: MonitorInput): MonitorState {
  const { holder, viewerHasScope, catalogSize } = input;
  if (holder === null) {
    return viewerHasScope ? { kind: "designate-needed" } : { kind: "grant-needed" };
  }
  const ref: HolderRef = { characterId: holder.characterId, name: holder.name };
  if (!holder.scopes.includes(ACCESS_LISTS_SCOPE)) {
    return { kind: "scope-dropped", holder: ref };
  }
  if (holder.tokenStatus === "needs_reauth") {
    return { kind: "holder-needs-reauth", holder: ref };
  }
  if (holder.tokenStatus === "invalid" || holder.tokenStatus === "missing") {
    return { kind: "holder-no-token", holder: ref, tokenStatus: holder.tokenStatus };
  }
  if (catalogSize === 0) return { kind: "catalog-empty", holder: ref };
  return { kind: "normal", holder: ref };
}

/**
 * The one sentence above the fold. Each dark-monitor state names the holder,
 * says plainly that nothing is being read, and states the fault — the single
 * holder makes these the likeliest way the feature dies quietly, and a page
 * that renders zero rows without saying why is indistinguishable from a page
 * saying everything is fine.
 */
export function monitorSentence(state: MonitorState): string {
  switch (state.kind) {
    case "grant-needed":
      return (
        "This page compares the alliance roster against the in-game access lists. " +
        "Nobody has granted the access-list scope yet, so nothing can be read."
      );
    case "designate-needed":
      return (
        "Your character has granted the access-list scope. Designate it as the " +
        "holder to start reading lists."
      );
    case "scope-dropped":
      return (
        `${state.holder.name} is the holder, but no longer carries the access-list ` +
        "scope — an ordinary re-authentication drops it. No reads are happening."
      );
    case "holder-needs-reauth":
      return (
        `${state.holder.name} is the holder, and its authorization has gone stale. ` +
        "No reads are happening until it re-authenticates."
      );
    case "holder-no-token":
      return state.tokenStatus === "missing"
        ? `${state.holder.name} is the holder, but there is no stored token for it at ` +
            "all. No reads are happening."
        : `${state.holder.name} is the holder, and its stored token stopped working. ` +
            "No reads are happening.";
    case "catalog-empty":
      return `${state.holder.name} is the holder. No lists have been discovered yet.`;
    case "normal":
      return `${state.holder.name} is the holder.`;
  }
}

export type Remedy =
  | { kind: "link"; label: string; href: string }
  | { kind: "designate" }
  | { kind: "check-now" };

const GRANT_HREF = "/auth/eve/link?grant=access-lists";

/**
 * The one action that fixes the state. A total function over the union rather
 * than a `Record`, because two members vary their remedy by a second field and
 * a `Record` keyed on `kind` alone could not express that — but still
 * exhaustive, so a new state is a compile error here rather than a state
 * rendering with no way out of it.
 *
 * `scope-dropped` and `grant-needed` share `GRANT_HREF`; the two token states
 * share the bare `/auth/eve/link`. That split is the load-bearing part: the
 * bare link is what drops the ACL scope in the first place, so it must never
 * be the remedy offered for a missing scope.
 */
export function monitorRemedy(state: MonitorState): Remedy {
  switch (state.kind) {
    case "grant-needed":
      return { kind: "link", label: "Grant access", href: GRANT_HREF };
    case "designate-needed":
      return { kind: "designate" };
    case "scope-dropped":
      return { kind: "link", label: "Re-grant access", href: GRANT_HREF };
    case "holder-needs-reauth":
      return { kind: "link", label: "Re-authenticate", href: "/auth/eve/link" };
    case "holder-no-token":
      return { kind: "link", label: "Add this character again", href: "/auth/eve/link" };
    case "catalog-empty":
    case "normal":
      return { kind: "check-now" };
  }
}

/**
 * Whether the watched-list table renders under the problem sentence. True for
 * every state that has a holder: a stale answer with its age beats a blank
 * page, and the age is what tells the admin how long the monitor has been
 * dark. False only when no holder was ever designated, where there is nothing
 * to be stale about.
 */
export function showsObservations(state: MonitorState): boolean {
  return state.kind !== "grant-needed" && state.kind !== "designate-needed";
}

export type WatchedRow = {
  accessListId: number;
  name: string | null;
  /** null when the job has never attempted this list — no snapshot row. */
  readStatus: AccessListReadStatus | null;
  observedAt: Date | null;
  allowEveryone: boolean | null;
  missingAccess: number;
  nonMembers: number;
  broadGrants: number;
};

function drifted(row: WatchedRow): boolean {
  return row.missingAccess > 0 || row.nonMembers > 0;
}

/**
 * `bad` is not in this function's range, and that is a rule rather than an
 * omission: PRODUCT.md reserves the alarm colour for destructive acts, and
 * nothing this page reports is one — every row here is a read of a list only a
 * human can change in-game. Drift is `warn`, a failed read is `warn`, and a
 * list nobody has read yet is `off` for the same reason `sync/view.ts` gives
 * `never` that tone: it has not failed at anything.
 */
export function rowTone(row: WatchedRow): Tone {
  if (row.readStatus === null) return "off";
  if (row.readStatus !== "ok") return "warn";
  if (row.allowEveryone === true) return "warn";
  return drifted(row) ? "warn" : "ok";
}

/**
 * The words beside the tone, so colour is never the sole carrier. A read
 * failure preempts the drift counts rather than printing beside them: those
 * counts were computed from the last *successful* read, and stating them as
 * this row's current answer would date a stale number to now.
 *
 * `allow_everyone` gets its own wording rather than "in sync". Such a list has
 * zero missing members by construction, so the ordinary clean sentence would
 * read as "correctly configured" when it means "open to everyone".
 */
export function rowSummary(row: WatchedRow): string {
  if (row.readStatus === null) return "not read yet";
  if (row.readStatus === "not_visible") return "not visible to holder";
  if (row.readStatus === "failed") return "read failed";
  if (row.allowEveryone === true) return "open to everyone";
  const parts: string[] = [];
  if (row.missingAccess > 0) parts.push(`${row.missingAccess} missing access`);
  if (row.nonMembers > 0) {
    parts.push(`${row.nonMembers} has access, not a member`);
  }
  return parts.length === 0 ? "in sync" : parts.join(" · ");
}

/**
 * Whether this row gets a disclosure control at all. A clean list is one line
 * with nothing to open — the common case on a page whose whole job is to be
 * boring — and a row with no detail behind a toggle is a control that promises
 * something and delivers an empty box.
 *
 * A never-read row has no detail either: there is no snapshot to describe.
 */
export function rowHasDetail(row: WatchedRow): boolean {
  if (row.readStatus === null) return false;
  if (row.readStatus !== "ok") return true;
  return row.allowEveryone === true || row.broadGrants > 0 || drifted(row);
}

/**
 * `HH:MM:SS.mmm UTC` for the enqueue instant in `?at=`, or null. Lifted
 * wholesale from `admin/sync/view.ts`'s `queuedStamp` and for its reasons:
 * the query string is untrusted input reaching copy, milliseconds are what let
 * a second press of the same button produce a different string, and the length
 * check catches the extended-year ISO form a hand-edited `?at=` reaches first.
 */
export function doneStamp(at: string | undefined): string | null {
  if (at === undefined || !/^\d{1,15}$/.test(at)) return null;
  const d = new Date(Number(at));
  if (Number.isNaN(d.getTime())) return null;
  const iso = d.toISOString();
  if (iso.length !== 24) return null;
  return `${iso.slice(11, 23)} UTC`;
}

/**
 * The outcome of the press that produced this render, for the three actions
 * that redirect. An unrecognized marker yields the empty string rather than
 * being echoed — `Notice` renders an empty slot for it, which is the shape
 * that keeps its live region announcing changes rather than being born full.
 */
export function doneNotice(done: string | undefined, at: string | undefined): string {
  const stamp = doneStamp(at);
  const when = stamp === null ? "" : ` at ${stamp}`;
  if (done === "holder") {
    return `Holder designated${when}. The next read will use it.`;
  }
  if (done === "watch") {
    return `List added to the watchlist${when}. It is read on the next run.`;
  }
  if (done === "check") {
    return `Check queued${when}. Reload this page once the worker has run.`;
  }
  return "";
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `npx vitest run tests/access-lists-view.test.ts`
Expected: all describe blocks green. `AccessListReadStatus` was exported from
`src/db/schema.ts` in Task 3 Step 3; if the import fails, that step was skipped.
Go back and do it there — do not add the type here, because this task's commit
does not include the schema.

- [ ] **Step 6: Format check**

Run: `npm run format:check`
On failure: `npm run format` and re-run; do not hand-wrap.

- [ ] **Step 7: Commit**

```bash
git add src/app/admin/access-lists/view.ts tests/access-lists-view.test.ts
git commit -m "feat(access-lists): the monitor page's pure state, tone and remedy rules"
```

---

### Task 10: The page, its actions, and the nav entry

**Files:**

- Create: `src/app/admin/access-lists/page.tsx`
- Create: `src/app/admin/access-lists/actions.ts`
- Modify: `src/services/access-lists.ts` (add the four page-side reads)
- Modify: `src/app/_components/nav-items.ts:20-24` (docblock rule list),
  `:31-33` (the order sentence), `:77-81` (the item constants), `:107-113`
  (`navFor`)
- Modify: `tests/nav-items.test.ts:24-28`, `:37-42`, `:59-63` (the three
  admin-visible label arrays)
- Test: `tests/access-lists-actions.test.ts`

**Interfaces:**

- Consumes: `requireAdminPage` / `requireAdminAction` (`@/lib/admin-guard`),
  `logAudit` (`@/services/audit`), `enqueueSync` (`@/services/outbox`),
  `getHolder` / `designateHolder` / `getWatchedListIds` / `addWatch` /
  `removeWatch` (`@/services/access-lists`), `compareAccessList`
  (`@/core/access-list-compare`), `getMemberCharacters` (`@/services/desired` — for the comparison roster only),
  `lookupEntityNames` (`@/services/entity-names`), `ActionOutcome` /
  `ConfirmGroup` / `ConfirmingForm` (`@/app/_components/confirm-group`),
  `Disclosure`, `Notice` / `RuleHead` / `Scroller` / `Status`, `Submit`,
  `ConfirmNotice`, `RelativeTime`, and everything Task 9 exports.
- Produces:

```ts
// src/app/admin/access-lists/actions.ts
export async function designateHolderAction(formData: FormData): Promise<void>;
export async function addWatchAction(formData: FormData): Promise<void>;
export async function checkNowAction(): Promise<void>;
export async function removeWatchAction(
  _prevState: ActionOutcome,
  formData: FormData,
): Promise<ActionOutcome>;

// src/services/access-lists.ts (additions)
export type HolderView = {
  characterId: number;
  name: string;
  scopes: string[];
  tokenStatus: "valid" | "invalid" | "needs_reauth" | "missing";
  designatedAt: Date;
};
export async function getHolderView(dbx: Dbx): Promise<HolderView | null>;
export type CatalogEntry = { accessListId: number; name: string };
export async function getCatalog(dbx: Dbx): Promise<CatalogEntry[]>;
export type WatchedListView = {
  accessListId: number;
  name: string | null;
  readStatus: AccessListReadStatus | null;
  observedAt: Date | null;
  lastAttemptAt: Date | null;
  detail: string | null;
  allowEveryone: boolean | null;
  entries: AccessEntry[];
};
export async function getWatchedListViews(dbx: Dbx): Promise<WatchedListView[]>;
export type OwnCharacter = {
  characterId: number;
  name: string;
  scopes: string[];
};
export async function getOwnCharacters(
  dbx: Dbx,
  accountId: string,
): Promise<OwnCharacter[]>;
```

`getOwnCharacters` is deliberately NOT `getMemberCharacters`
(`src/services/desired.ts:35-47`), which inner-joins `account.tier = 'member'`.
`isAdmin` and `tier` are orthogonal columns, and the nav docblock
(`src/app/_components/nav-items.ts:25-29`) says so outright: an admin's default
tier is `alumni`. An alumni admin has no row in the member roster, so sourcing
the designate button from it would leave them permanently unable to designate
anyone — the page would show "Grant access", they would grant it, and the button
would still not appear. The roster read stays for the *comparison*, which is
about members by definition; only the viewer's own picker moves.

The audited mutations — `designateHolder`, `addWatch`, `removeWatch` — and their
tests already landed in Task 6, and the holder-FK cascade is covered by Task 3.
This task adds only what the page itself needs: the three read models, the
actions, the JSX, and the nav entry.

- [ ] **Step 1: Write the failing test — the four page-side reads**

The repo does not mock `requireAdminAction` or `next/navigation` anywhere, so
the actions themselves are covered end-to-end in Task 11. What is worth a unit
test here is the four reads: each one is a join whose *empty* and *partial*
shapes are exactly what the page's seven states are built from.

Create `tests/access-lists-reads.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  accessListCatalog,
  accessListEntry,
  accessListHolder,
  accessListSnapshot,
  accessListWatch,
} from "@/db/schema";
import {
  getCatalog,
  getHolderView,
  getOwnCharacters,
  getWatchedListViews,
} from "@/services/access-lists";
import { setupTestDb, truncateAll } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";

const cfg = testConfig();
const HOLDER = 90000001;

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

async function seedHolder(
  opts: { scopes?: string[]; tokenStatus?: "valid" | "needs_reauth" } = {},
) {
  const acc = await seedAccount(ctx.db, { tier: "member", isAdmin: true });
  await seedCharacter(ctx.db, cfg, {
    id: HOLDER,
    accountId: acc.id,
    main: true,
    name: "Vela Kaine",
    scopes: opts.scopes ?? [...cfg.eveSso.scopes, "esi-access.read_lists.v1"],
    tokenStatus: opts.tokenStatus ?? "valid",
  });
  await ctx.db
    .insert(accessListHolder)
    .values({ id: 1, characterId: HOLDER, designatedBy: acc.id });
  return acc;
}

describe("getHolderView", () => {
  it("returns null when nothing is designated", async () => {
    expect(await getHolderView(ctx.db)).toBeNull();
  });

  it("joins the character's name, scopes and token status onto the designation", async () => {
    // These four fields ARE the page's first three states: no holder, holder
    // without the scope, holder whose token went bad. A join that dropped any
    // of them would make those states unrenderable.
    await seedHolder({ scopes: ["esi-characters.read_contacts.v1"] });
    const view = await getHolderView(ctx.db);
    expect(view).toMatchObject({
      characterId: HOLDER,
      name: "Vela Kaine",
      scopes: ["esi-characters.read_contacts.v1"],
      tokenStatus: "valid",
    });
    expect(view?.designatedAt).toBeInstanceOf(Date);
  });
});

describe("getCatalog", () => {
  it("returns the discovered lists in id order", async () => {
    await seedHolder();
    await ctx.db.insert(accessListCatalog).values([
      { accessListId: 9, name: "Staging", observedByCharacterId: HOLDER },
      { accessListId: 3, name: "Home", observedByCharacterId: HOLDER },
    ]);
    expect(await getCatalog(ctx.db)).toEqual([
      { accessListId: 3, name: "Home" },
      { accessListId: 9, name: "Staging" },
    ]);
  });

  it("is empty before the job has ever run", async () => {
    expect(await getCatalog(ctx.db)).toEqual([]);
  });
});

describe("getWatchedListViews", () => {
  it("returns a watched list that has never been read, rather than dropping it", async () => {
    // A list watched a minute ago has no snapshot row. "Never read" is a state
    // the page renders; an inner join would silently lose the row instead.
    const acc = await seedHolder();
    await ctx.db
      .insert(accessListWatch)
      .values({ accessListId: 42, addedBy: acc.id });
    const views = await getWatchedListViews(ctx.db);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      accessListId: 42,
      name: null,
      readStatus: null,
      observedAt: null,
      lastAttemptAt: null,
      allowEveryone: null,
      entries: [],
    });
  });

  it("attaches each list's entries and nothing else's", async () => {
    const acc = await seedHolder();
    await ctx.db
      .insert(accessListWatch)
      .values([
        { accessListId: 42, addedBy: acc.id },
        { accessListId: 7, addedBy: acc.id },
      ]);
    await ctx.db.insert(accessListSnapshot).values([
      {
        accessListId: 42,
        observedByCharacterId: HOLDER,
        name: "Home Structures",
        readStatus: "ok",
        observedAt: new Date(),
        lastAttemptAt: new Date(),
        allowEveryone: false,
      },
      {
        accessListId: 7,
        observedByCharacterId: HOLDER,
        name: "Staging",
        readStatus: "not_visible",
        lastAttemptAt: new Date(),
        detail: "403",
      },
    ]);
    await ctx.db.insert(accessListEntry).values([
      { accessListId: 42, kind: "character", entityId: 1, access: "member" },
      { accessListId: 42, kind: "corporation", entityId: 500, access: "member" },
      { accessListId: 7, kind: "alliance", entityId: 900, access: "blocked" },
    ]);

    const views = await getWatchedListViews(ctx.db);
    // Ordered by list id, so 7 comes first.
    expect(views.map((v) => v.accessListId)).toEqual([7, 42]);
    expect(views[0]).toMatchObject({
      name: "Staging",
      readStatus: "not_visible",
      observedAt: null,
      detail: "403",
    });
    expect(views[0].entries).toEqual([
      { kind: "alliance", entityId: 900, access: "blocked" },
    ]);
    expect(views[1].entries).toHaveLength(2);
    expect(views[1].entries.map((e) => e.entityId).sort()).toEqual([1, 500]);
  });

  it("ignores entries for lists nobody is watching", async () => {
    // The job writes entries for every list it reads; the page shows only the
    // watched ones. A missing WHERE here would leak unwatched lists onto it.
    await seedHolder();
    await ctx.db
      .insert(accessListEntry)
      .values({ accessListId: 999, kind: "character", entityId: 1, access: "member" });
    expect(await getWatchedListViews(ctx.db)).toEqual([]);
  });
});

describe("getOwnCharacters", () => {
  it("returns an alumni admin's own characters", async () => {
    // The regression this exists for: `getMemberCharacters` joins
    // `account.tier = 'member'`, and an admin's default tier is `alumni`. Off
    // that read, this admin has no characters and can never designate a holder.
    const acc = await seedAccount(ctx.db, { tier: "alumni", isAdmin: true });
    await seedCharacter(ctx.db, cfg, {
      id: HOLDER,
      accountId: acc.id,
      main: true,
      name: "Vela Kaine",
      scopes: [...cfg.eveSso.scopes, "esi-access.read_lists.v1"],
    });
    expect(await getOwnCharacters(ctx.db, acc.id)).toEqual([
      {
        characterId: HOLDER,
        name: "Vela Kaine",
        scopes: [...cfg.eveSso.scopes, "esi-access.read_lists.v1"],
      },
    ]);
  });

  it("does not return another account's characters", async () => {
    const mine = await seedAccount(ctx.db, { tier: "member", isAdmin: true });
    const theirs = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, {
      id: 90000002,
      accountId: theirs.id,
      main: true,
      name: "Someone Else",
    });
    expect(await getOwnCharacters(ctx.db, mine.id)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/access-lists-reads.test.ts`
Expected: FAIL at import — `getHolderView`, `getCatalog`,
`getWatchedListViews` and `getOwnCharacters` are not exported by
`src/services/access-lists.ts` yet.
Quote the real output.

- [ ] **Step 3: Add the four page-side reads to the service**

Still in `src/services/access-lists.ts`. Task 6 Step 7 wrote the file's imports
as `{ asc, eq }` from `drizzle-orm` plus four schema tables; these four reads
need more, so widen the two existing import statements first — do not add a
second import of the same module:

```ts
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  accessListCatalog,
  accessListEntry,
  accessListHolder,
  accessListSnapshot,
  accessListWatch,
  character,
  type AccessListReadStatus,
} from "@/db/schema";
```

and add one new import — Task 6's version of this file has none from `core`:

```ts
import type { AccessEntry } from "@/core/access-list-compare";
```

Then append:

```ts
export type HolderView = {
  characterId: number;
  name: string;
  scopes: string[];
  tokenStatus: "valid" | "invalid" | "needs_reauth" | "missing";
  designatedAt: Date;
};

/** The holder joined to its character row — the four fields `monitorState`
 *  needs. Separate from `getHolder` (which the job uses and which must stay a
 *  single-table read for the stale-holder compare-and-swap). */
export async function getHolderView(dbx: Dbx): Promise<HolderView | null> {
  const [row] = await dbx
    .select({
      characterId: character.id,
      name: character.name,
      scopes: character.scopes,
      tokenStatus: character.tokenStatus,
      designatedAt: accessListHolder.designatedAt,
    })
    .from(accessListHolder)
    .innerJoin(character, eq(character.id, accessListHolder.characterId))
    .where(eq(accessListHolder.id, 1));
  return row ?? null;
}

export type CatalogEntry = { accessListId: number; name: string };

export async function getCatalog(dbx: Dbx): Promise<CatalogEntry[]> {
  return dbx
    .select({
      accessListId: accessListCatalog.accessListId,
      name: accessListCatalog.name,
    })
    .from(accessListCatalog)
    .orderBy(accessListCatalog.accessListId);
}

export type WatchedListView = {
  accessListId: number;
  name: string | null;
  readStatus: AccessListReadStatus | null;
  observedAt: Date | null;
  lastAttemptAt: Date | null;
  detail: string | null;
  allowEveryone: boolean | null;
  entries: AccessEntry[];
};

/**
 * Every watched list, LEFT-joined to its snapshot: a list added to the
 * watchlist a minute ago has no snapshot row at all, and that "never read"
 * state is one the page renders rather than a row it drops.
 */
export async function getWatchedListViews(dbx: Dbx): Promise<WatchedListView[]> {
  const rows = await dbx
    .select({
      accessListId: accessListWatch.accessListId,
      name: accessListSnapshot.name,
      readStatus: accessListSnapshot.readStatus,
      observedAt: accessListSnapshot.observedAt,
      lastAttemptAt: accessListSnapshot.lastAttemptAt,
      detail: accessListSnapshot.detail,
      allowEveryone: accessListSnapshot.allowEveryone,
    })
    .from(accessListWatch)
    .leftJoin(
      accessListSnapshot,
      eq(accessListSnapshot.accessListId, accessListWatch.accessListId),
    )
    .orderBy(accessListWatch.accessListId);
  if (rows.length === 0) return [];
  const entries = await dbx
    .select({
      accessListId: accessListEntry.accessListId,
      kind: accessListEntry.kind,
      entityId: accessListEntry.entityId,
      access: accessListEntry.access,
    })
    .from(accessListEntry)
    .where(
      inArray(
        accessListEntry.accessListId,
        rows.map((r) => r.accessListId),
      ),
    );
  return rows.map((r) => ({
    ...r,
    entries: entries
      .filter((e) => e.accessListId === r.accessListId)
      .map(({ kind, entityId, access }) => ({ kind, entityId, access })),
  }));
}

export type OwnCharacter = {
  characterId: number;
  name: string;
  scopes: string[];
};

/**
 * The viewer's own linked characters, for the "Designate as holder" control.
 *
 * Tier-independent on purpose. `getMemberCharacters` (`services/desired.ts`)
 * inner-joins `account.tier = 'member'`, which is right for the desired set and
 * wrong here: `isAdmin` and `tier` are orthogonal, and an admin's default tier
 * is `alumni` (`_components/nav-items.ts`). Sourcing this from the member
 * roster would leave an alumni admin looking at a "Grant access" button that
 * never becomes "Designate as holder", with nothing on the page to explain it.
 *
 * `affiliationInvalid` characters are excluded — ESI rejects them, so one
 * could never actually hold the designation.
 */
export async function getOwnCharacters(
  dbx: Dbx,
  accountId: string,
): Promise<OwnCharacter[]> {
  return dbx
    .select({
      characterId: character.id,
      name: character.name,
      scopes: character.scopes,
    })
    .from(character)
    .where(
      and(eq(character.accountId, accountId), eq(character.affiliationInvalid, false)),
    )
    .orderBy(character.id);
}
```

Run: `npx vitest run tests/access-lists-reads.test.ts` — expected green, nine
cases across the four describe blocks.

Run: `npm run typecheck` — expected clean.

- [ ] **Step 4: Write `actions.ts`**

Create `src/app/admin/access-lists/actions.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { requireAdminAction } from "@/lib/admin-guard";
import { enqueueSync } from "@/services/outbox";
import { addWatch, designateHolder, removeWatch } from "@/services/access-lists";
import { type ActionOutcome } from "@/app/_components/confirm-group";

/**
 * Every action here gates itself with `requireAdminAction`. The admin layout's
 * guard does not protect server actions and does not re-run on soft
 * navigation, so "the page checked already" is not a check.
 *
 * None of the four calls ESI. This page reads Postgres and enqueues; the
 * worker performs every read.
 */

/** A server action takes whatever the wire sends, so an id that will become a
 *  bigint column and an audit target is parsed rather than trusted.
 *  Unreachable from the rendered page, so a bad value throws rather than
 *  earning notice copy — the same posture `syncJobAction` takes on `jobType`. */
function parseId(value: FormDataEntryValue | null): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error("invalid_id");
  return n;
}

export async function designateHolderAction(formData: FormData): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  const characterId = parseId(formData.get("characterId"));
  await designateHolder(getDb(), characterId, actor);
  revalidatePath("/admin/access-lists");
  redirect(`/admin/access-lists?done=holder&at=${Date.now()}`);
}

export async function addWatchAction(formData: FormData): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  const accessListId = parseId(formData.get("accessListId"));
  await addWatch(getDb(), accessListId, actor);
  revalidatePath("/admin/access-lists");
  redirect(`/admin/access-lists?done=watch&at=${Date.now()}`);
}

/**
 * Enqueues the read and writes NO audit row. Asking for a read changes no
 * state, and `runJob` already records the run in `syncRun` — the same reason
 * `/admin/sync`'s re-run buttons audit at the request rather than the
 * execution, except that this request is not itself a state change at all.
 */
export async function checkNowAction(): Promise<void> {
  await requireAdminAction();
  await enqueueSync(getDb(), { kind: "job", jobType: "access-lists" });
  revalidatePath("/admin/access-lists");
  redirect(`/admin/access-lists?done=check&at=${Date.now()}`);
}

/**
 * The one action that does NOT redirect, and this is not a stylistic choice.
 * Its control sits inside that row's `Disclosure`, whose open/closed state is a
 * plain `useState` with nowhere else to live (`_components/disclosure.tsx`). A
 * `redirect()` — even back to this same route carrying nothing but
 * `?done=&at=` — replaces the whole route tree on navigation and resets that
 * `useState`, closing the drawer the admin opened in order to reach this
 * button. Two separate e2e runs have already caught this exact failure on two
 * separate pages (`/admin/accounts`'s row drawer and `/admin/sync`'s job
 * drawer); `_components/confirm-group.tsx`'s docblock is the record of both.
 * The confirmation comes back through `useActionState` instead.
 */
export async function removeWatchAction(
  _prevState: ActionOutcome,
  formData: FormData,
): Promise<ActionOutcome> {
  const { accountId: actor } = await requireAdminAction();
  const accessListId = parseId(formData.get("accessListId"));
  await removeWatch(getDb(), accessListId, actor);
  revalidatePath("/admin/access-lists");
  return { text: `Access list ${accessListId} removed from the watchlist.` };
}
```

- [ ] **Step 5: Write `page.tsx`**

Create `src/app/admin/access-lists/page.tsx`. This step writes the imports and
the default export only; it references `StopWatching` and the detail panel,
which Step 6 appends to the same file. **The file does not typecheck until Step
6 lands** — that is expected, do not go looking for a missing module, and do not
run `npm run typecheck` between the two.

```tsx
import type { Metadata } from "next";
import { getDb } from "@/db";
import { requireAdminPage } from "@/lib/admin-guard";
import { compareAccessList, type RosterCharacter } from "@/core/access-list-compare";
import { getMemberCharacters } from "@/services/desired";
import { lookupEntityNames } from "@/services/entity-names";
import { ACCESS_LISTS_SCOPE } from "@/lib/esi/client";
import {
  getCatalog,
  getHolderView,
  getOwnCharacters,
  getWatchedListViews,
} from "@/services/access-lists";
import { Notice, RuleHead, Scroller, Status } from "@/app/_components/ui";
import { ConfirmNotice } from "@/app/_components/confirm-notice";
import { ConfirmGroup, ConfirmingForm } from "@/app/_components/confirm-group";
import { Disclosure } from "@/app/_components/disclosure";
import { Submit } from "@/app/_components/submit";
import { RelativeTime } from "@/app/_components/relative-time";
import { formatAgo } from "@/app/_components/format-ago";
import {
  addWatchAction,
  checkNowAction,
  designateHolderAction,
  removeWatchAction,
} from "./actions";
import {
  doneNotice,
  monitorRemedy,
  monitorSentence,
  monitorState,
  rowHasDetail,
  rowSummary,
  rowTone,
  showsObservations,
  type WatchedRow,
} from "./view";

/**
 * The access-list monitor. It reads Postgres and nothing else: a live ESI
 * fetch on render would burn a refresh-token rotation per page load (EVE
 * rotates on use), block on two round-trips, have no staleness concept to
 * display, and be dead in dry-run. "Check now" enqueues; the worker reads.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Access lists",
};

export default async function AdminAccessListsPage({
  searchParams,
}: {
  searchParams: Promise<{ done?: string; at?: string }>;
}) {
  // Its own guard, not the layout's: a layout does not re-run on soft
  // navigation and never sees a server action.
  const { accountId } = await requireAdminPage();
  const { done, at } = await searchParams;
  const db = getDb();

  const [holder, catalog, watched, roster, mine] = await Promise.all([
    getHolderView(db),
    getCatalog(db),
    getWatchedListViews(db),
    getMemberCharacters(db),
    getOwnCharacters(db, accountId),
  ]);

  // The viewer's own characters decide between "Grant access" and "Designate
  // as holder": there is no point offering designation to an admin who has
  // nothing to designate. Read tier-independently — `roster` is the member set
  // and an admin is often an alumnus, so filtering it by `accountId` would come
  // back empty for exactly the people who administer this page.
  const grantable = mine.find((c) => c.scopes.includes(ACCESS_LISTS_SCOPE)) ?? null;

  const state = monitorState({
    holder,
    viewerHasScope: grantable !== null,
    catalogSize: catalog.length,
  });
  const remedy = monitorRemedy(state);

  const rosterForCompare: RosterCharacter[] = roster.map((c) => ({
    characterId: c.characterId,
    name: c.name,
    accountId: c.accountId,
    corporationId: c.corporationId,
    allianceId: c.allianceId,
  }));

  const compared = watched.map((w) => ({
    ...w,
    comparison: compareAccessList({
      allowEveryone: w.allowEveryone ?? false,
      entries: w.entries,
      roster: rosterForCompare,
    }),
  }));

  // One batched cache read for every id the detail panels will print, rather
  // than one per row. Unresolved ids render bare — `lookupEntityNames` is a
  // cache read, and a name we have never fetched is not a reason to fail a
  // page.
  const names = await lookupEntityNames(
    db,
    compared.flatMap((c) => [
      ...c.comparison.nonMembers,
      ...c.comparison.broadGrants.flatMap((g) => (g.entityId === null ? [] : [g.entityId])),
    ]),
  );

  const watchedIds = new Set(compared.map((c) => c.accessListId));
  const addable = catalog.filter((c) => !watchedIds.has(c.accessListId));
  const notice = doneNotice(done, at);

  return (
    <main id="main" className="page page--wide">
      <h1>Access lists</h1>
      <ConfirmNotice text={notice} at={at} />

      <p className="lede">{monitorSentence(state)}</p>

      <div className="btn-row btn-row--controls">
        {remedy.kind === "link" && (
          <a className="btn btn--primary" href={remedy.href}>
            {remedy.label}
          </a>
        )}
        {remedy.kind === "designate" && grantable !== null && (
          <form action={designateHolderAction}>
            <input type="hidden" name="characterId" value={grantable.characterId} />
            <Submit className="btn btn--primary" pendingLabel="Designating…">
              Designate as holder
            </Submit>
          </form>
        )}
        <form action={checkNowAction}>
          <Submit
            className={remedy.kind === "check-now" ? "btn btn--primary" : "btn"}
            pendingLabel="Queueing…"
          >
            Check now
          </Submit>
        </form>
      </div>

      {showsObservations(state) && (
        <>
          <RuleHead as="h2" aside={addable.length === 0 ? undefined : "add a list"}>
            Watched lists
          </RuleHead>

          {addable.length > 0 && (
            <form action={addWatchAction} className="btn-row">
              <label htmlFor="add-list">List</label>
              <select id="add-list" name="accessListId" defaultValue="">
                {addable.map((c) => (
                  <option key={c.accessListId} value={c.accessListId}>
                    {c.name}
                  </option>
                ))}
              </select>
              <Submit pendingLabel="Adding…">Add to watchlist</Submit>
            </form>
          )}

          {compared.length === 0 ? (
            <Notice>No lists are being watched yet.</Notice>
          ) : (
            <ul className="acl-list">
              {compared.map((c) => {
                const row: WatchedRow = {
                  accessListId: c.accessListId,
                  name: c.name,
                  readStatus: c.readStatus,
                  observedAt: c.observedAt,
                  allowEveryone: c.allowEveryone,
                  missingAccess: c.comparison.missingAccess.length,
                  nonMembers: c.comparison.nonMembers.length,
                  broadGrants: c.comparison.broadGrants.length,
                };
                const head = (
                  <span className="acl-list__head">
                    <span className="acl-list__name">
                      {c.name ?? `#${c.accessListId}`}
                    </span>
                    <Status tone={rowTone(row)}>{rowSummary(row)}</Status>
                    {/* Honest staleness: the last SUCCESSFUL read, never the
                        last attempt. A row whose latest attempt failed still
                        shows how old the answer under it is. */}
                    {c.observedAt !== null && (
                      <RelativeTime
                        at={c.observedAt.toISOString()}
                        initial={formatAgo(c.observedAt)}
                      />
                    )}
                  </span>
                );
                // Only rows with something to report expand. A clean list gets
                // no disclosure control at all, rather than a toggle that opens
                // an empty box — but it still gets its own "Stop watching",
                // inline. Putting that control only inside the drawer would
                // make a clean or never-read list permanently unremovable,
                // which is precisely the list an admin is most likely to want
                // off the page.
                if (!rowHasDetail(row)) {
                  return (
                    <li key={c.accessListId} className="acl-list__row">
                      {head}
                      <StopWatching accessListId={c.accessListId} />
                    </li>
                  );
                }
                return (
                  <li key={c.accessListId} className="acl-list__row">
                    <Disclosure summary={head} className="acl-list__disc">
                      <AccessListDetail
                        detail={c.detail}
                        readStatus={c.readStatus}
                        comparison={c.comparison}
                        names={names}
                      />
                      <StopWatching accessListId={c.accessListId} />
                    </Disclosure>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </main>
  );
}
```

- [ ] **Step 6: Write the detail panel**

Still in `page.tsx`, below the default export. First the shared control, so
both row shapes render exactly the same one:

```tsx
/**
 * The one control every watched row carries, expandable or not.
 *
 * `ConfirmGroup`/`ConfirmingForm`, not a bare form, in BOTH placements. Inside
 * the `Disclosure` that is load-bearing: a redirect would reset the drawer's
 * `useState` and close it on the very press that used it. Outside, it is
 * uniformity — one component, one confirm affordance, one label, so the two
 * branches cannot drift into two different removal experiences. `removeWatch`
 * is idempotent (Task 6), so a double submit is harmless either way.
 */
function StopWatching({ accessListId }: { accessListId: number }) {
  return (
    <ConfirmGroup>
      <ConfirmingForm action={removeWatchAction}>
        <input type="hidden" name="accessListId" value={accessListId} />
        <Submit className="btn btn--quiet" pendingLabel="Removing…">
          Stop watching
        </Submit>
      </ConfirmingForm>
    </ConfirmGroup>
  );
}

/**
 * Names lead and ids are secondary throughout: the admin retypes these in-game,
 * where the id is not what the client accepts.
 *
 * Broad grants always carry the "plus an unknown number of others" clause. We
 * store a corporation per character and hold no corp or alliance roster, so the
 * covered-member count is OUR members only — the page must never imply a
 * corp-granted list is fully accounted for.
 */
function AccessListDetail({
  detail,
  readStatus,
  comparison,
  names,
}: {
  detail: string | null;
  readStatus: AccessListReadStatus | null;
  comparison: AccessListComparison;
  names: Map<number, string>;
}) {
  return (
    <div className="acl-detail">
      {readStatus !== null && readStatus !== "ok" && (
        <Notice tone="warn">
          {readStatus === "not_visible"
            ? "The holder can no longer see this list. The membership below is the last successful read."
            : `The last read failed${detail === null ? "" : `: ${detail}`}. The membership below is the last successful read.`}
        </Notice>
      )}

      {comparison.missingAccess.length > 0 && (
        <>
          <RuleHead as="h3">Missing access ({comparison.missingAccess.length})</RuleHead>
          <Scroller label="Members missing access">
            <table>
              <thead>
                <tr>
                  <th scope="col">Character</th>
                  <th scope="col">Corporation</th>
                </tr>
              </thead>
              <tbody>
                {comparison.missingAccess.map((m) => (
                  <tr key={m.characterId}>
                    <td>{m.name}</td>
                    <td>
                      {m.corporationId === null
                        ? "—"
                        : (names.get(m.corporationId) ?? `#${m.corporationId}`)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroller>
        </>
      )}

      {comparison.nonMembers.length > 0 && (
        <>
          <RuleHead as="h3">
            Has access, not a member ({comparison.nonMembers.length})
          </RuleHead>
          <ul className="acl-detail__names">
            {comparison.nonMembers.map((id) => (
              <li key={id}>{names.get(id) ?? `#${id}`}</li>
            ))}
          </ul>
        </>
      )}

      {comparison.broadGrants.length > 0 && (
        <>
          <RuleHead as="h3">Broad grants ({comparison.broadGrants.length})</RuleHead>
          <ul className="acl-detail__names">
            {comparison.broadGrants.map((g) => (
              <li key={`${g.kind}:${g.entityId ?? "all"}`}>
                {g.kind === "everyone"
                  ? "Open to everyone"
                  : `${g.kind === "corporation" ? "Corporation" : "Alliance"} ${
                      g.entityId === null
                        ? ""
                        : (names.get(g.entityId) ?? `#${g.entityId}`)
                    }`}
                {" — covers "}
                {g.coveredMembers} of our members, plus an unknown number of others
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
```

Add the imports these two blocks need at the top of `page.tsx`:
`ACCESS_LISTS_SCOPE` from `@/lib/esi/client`, `type AccessListComparison` from
`@/core/access-list-compare`, and `type AccessListReadStatus` from `@/db/schema`.

- [ ] **Step 7: Add the nav entry**

In `src/app/_components/nav-items.ts`:

```ts
const ACCESS_LISTS: NavItem = { href: "/admin/access-lists", label: "Access lists" };
```

placed after `SYNC` (line 81), and `navFor` becomes:

```ts
export function navFor({ canReadPayouts, isAdmin }: Reach): NavItem[] {
  return [
    ACCOUNT,
    ...(canReadPayouts ? [PAYOUTS] : []),
    ...(isAdmin ? [MEMBERS, AUDIT, SYNC, ACCESS_LISTS] : []),
  ];
}
```

- [ ] **Step 8: Update the docblock's rule list — the label must appear exactly once**

The module docblock enumerates the labels (lines 20-24) and states the fixed
order (lines 31-33). Both are prose about a list this edit changed, so both are
now wrong. Add to the rule list:

```
 *   Access lists  — iff isAdmin
```

and extend the order sentence's enumeration to "Your account, Operations,
Members, Audit log, Sync, Access lists", changing "the same five-item list" to
"the same six-item list" in both places it appears.

This is not tidying. The docblock's own argument is that the label string lives
in this module exactly once, because two spellings of one destination fail WCAG
3.2.4 Consistent Identification — and a docblock listing five labels beside an
array of six is the second spelling arriving by the back door. Verify with:

Run: `grep -c "Access lists" src/app/_components/nav-items.ts`
Expected: `2` — once in the docblock rule list, once in the `NavItem`. Any other
count means either the docblock was missed or a second literal crept in.

- [ ] **Step 9: Update `tests/nav-items.test.ts`**

Three label arrays assert the admin-visible set and all three now fail. Add
`"Access lists"` after `"Sync"` in each:

- `:24-28` — `navFor({ canReadPayouts: false, isAdmin: true })`
- `:37-42` — `navFor({ canReadPayouts: true, isAdmin: true })`
- `:59-63` — `navFromPath("/admin/audit")`

Run: `npx vitest run tests/nav-items.test.ts`
Expected: green. If a fourth array fails, it is a case this step missed — add it
rather than loosening the assertion to a `toContain`.

- [ ] **Step 10: Typecheck and format**

Run: `npm run typecheck && npm run format:check`
On typecheck failure: the likeliest cause is `getMemberCharacters` not yet
carrying `corporationId`/`allianceId` — that is Task 8's additive change to
`MemberCharacter`; confirm it landed before editing `page.tsx` around it.
On format failure: `npm run format`.

- [ ] **Step 11: Commit**

```bash
git add src/app/admin/access-lists/page.tsx src/app/admin/access-lists/actions.ts \
  src/services/access-lists.ts src/app/_components/nav-items.ts \
  tests/access-lists-actions.test.ts tests/nav-items.test.ts
git commit -m "feat(access-lists): the monitor page, its four actions, and the nav entry"
```

---

### Task 11: End-to-end coverage

**Files:**

- Create: `e2e/access-lists.spec.ts`
- Modify: `e2e/helpers.ts:11-20` (the `TRUNCATE` list)
- Modify: `e2e/shell.spec.ts:39` (the route/label/aria-current table) and its
  two admin `toHaveText` arrays (~`:102-107`, ~`:121-126`)

**Interfaces:**

- Consumes: `resetDb` / `seedMember` / `sessionCookieFor` / `testDb`
  (`./helpers`), the six new tables from `../src/db/schema`, `ACCESS_LISTS_SCOPE`
  (`../src/lib/esi/client`).
- Produces: nothing other code imports.

> **Never run two e2e suites concurrently in the same worktree.** They share one
> database and each run's `resetDb` truncates the other's rows mid-test. It does
> not surface as a race — it surfaces as "not signed in" or the "Something
> broke" error boundary in a test that has nothing to do with sessions, which
> costs an hour of debugging the wrong file. One `npm run test:e2e` at a time,
> per worktree.

- [ ] **Step 1: Add the six new tables to `resetDb`**

`e2e/helpers.ts`'s `TRUNCATE` names its tables explicitly, so a table absent
from that list keeps its rows across every test in the run. Extend it:

```ts
export async function resetDb(db: ReturnType<typeof testDb>["db"]) {
  await db.execute(sql`
    TRUNCATE account, "character", discord_link, session, bootstrap_admin_grant,
      outbox, oauth_transaction, contact_sync_state, sync_run,
      wanderer_acl_observation, audit_log, payout_operation, loot_pool,
      loot_item, payout_participant, payout_payment, universe_name,
      access_list_holder, access_list_catalog, access_list_watch,
      access_list_snapshot, access_list_entry, esi_entity_name
      RESTART IDENTITY CASCADE
  `);
}
```

- [ ] **Step 2: Write the spec's header and seed helpers**

Create `e2e/access-lists.spec.ts`:

```ts
/**
 * SEED TIMES HERE MUST BE RELATIVE TO `Date.now()`, NEVER A LITERAL DATE.
 *
 * Same discipline `sync.spec.ts` states at the top of itself, for the same
 * reason: this page renders every observation with its age, so a snapshot
 * pinned to a fixed instant reads as fresh on the day the test is written and
 * as months-stale forever after — and it fails as a stale assertion in an
 * unrelated run long after the line that caused it. Use `ago()`.
 *
 * Every row here is seeded DIRECTLY. Dry-run forbids live reads and the job
 * refuses to run without a token, so the job cannot produce fixtures; the
 * tables are the contract this page reads and the tests write them.
 */
import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import {
  accessListCatalog,
  accessListEntry,
  accessListHolder,
  accessListSnapshot,
  accessListWatch,
  character,
} from "../src/db/schema";
import { ACCESS_LISTS_SCOPE } from "../src/lib/esi/client";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";

const { db, pool } = testDb();

test.afterAll(() => pool.end());
test.beforeEach(() => resetDb(db));

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);

const LIST_ID = 4001;

/**
 * An admin whose main character carries whatever scope the test needs, signed
 * in. Returns the character id so the holder row can point at it.
 */
async function asAdmin(
  context: import("@playwright/test").BrowserContext,
  opts: { scopes?: string[]; tokenStatus?: "valid" | "invalid" | "needs_reauth" | "missing" } = {},
) {
  const acc = await seedMember(db, { name: "Vela Kaine", tier: "member", isAdmin: true });
  const [c] = await db
    .update(character)
    .set({
      scopes: opts.scopes ?? [ACCESS_LISTS_SCOPE],
      tokenStatus: opts.tokenStatus ?? "valid",
    })
    .where(eq(character.accountId, acc.id))
    .returning({ id: character.id });
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  return { accountId: acc.id, characterId: c.id };
}

async function seedHolder(characterId: number) {
  await db.insert(accessListHolder).values({ id: 1, characterId, designatedBy: "e2e" });
}

async function seedCatalog(characterId: number) {
  await db.insert(accessListCatalog).values({
    accessListId: LIST_ID,
    name: "Fleet staging",
    discoveredAt: ago(10 * MIN),
    observedByCharacterId: characterId,
  });
}

/** A watched list with a successful read and the membership rows behind it. */
async function seedWatched(
  characterId: number,
  opts: {
    readStatus?: "ok" | "not_visible" | "failed";
    allowEveryone?: boolean;
    entries?: Array<{ kind: "character" | "corporation" | "alliance"; entityId: number }>;
    detail?: string | null;
  } = {},
) {
  await db.insert(accessListWatch).values({ accessListId: LIST_ID, addedBy: "e2e" });
  await db.insert(accessListSnapshot).values({
    accessListId: LIST_ID,
    observedAt: ago(3 * MIN),
    lastAttemptAt: ago(3 * MIN),
    readStatus: opts.readStatus ?? "ok",
    observedByCharacterId: characterId,
    name: "Fleet staging",
    description: "",
    allowEveryone: opts.allowEveryone ?? false,
    detail: opts.detail ?? null,
  });
  for (const e of opts.entries ?? []) {
    await db
      .insert(accessListEntry)
      .values({ accessListId: LIST_ID, kind: e.kind, entityId: e.entityId, access: "member" });
  }
}
```

- [ ] **Step 3: Assert states 1 and 2 (no holder)**

```ts
test("state 1: no holder and no scope asks for the grant, and shows no table", async ({
  page,
  context,
}) => {
  await asAdmin(context, { scopes: [] });
  await page.goto("/admin/access-lists");

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Access lists");
  await expect(page.locator(".lede")).toContainText("Nobody has granted");
  await expect(page.getByRole("link", { name: "Grant access" })).toHaveAttribute(
    "href",
    "/auth/eve/link?grant=access-lists",
  );
  // Nothing to be stale about, so no watched-list section at all — an empty
  // table here would read as "no drift".
  await expect(page.getByRole("heading", { name: "Watched lists" })).toHaveCount(0);
});

test("state 2: a granted character with no holder gets the designate button", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await page.goto("/admin/access-lists");

  await expect(page.locator(".lede")).toContainText("Designate it as the holder");
  await expect(page.getByRole("button", { name: "Designate as holder" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Grant access" })).toHaveCount(0);
});
```

- [ ] **Step 4: Assert states 3, 4 and 5 (the dark-monitor cases)**

```ts
test("state 3: a holder whose scope was dropped is offered the GRANTING link, not a plain re-auth", async ({
  page,
  context,
}) => {
  // The distinction is the whole point: the plain /auth/eve/link is what drops
  // the scope, so offering it here would send the admin round the loop that
  // caused the outage.
  const { characterId } = await asAdmin(context, { scopes: [] });
  await seedHolder(characterId);
  await seedCatalog(characterId);
  await seedWatched(characterId);
  await page.goto("/admin/access-lists");

  await expect(page.locator(".lede")).toContainText("no longer carries the access-list");
  await expect(page.locator(".lede")).toContainText("No reads are happening");
  await expect(page.getByRole("link", { name: "Re-grant access" })).toHaveAttribute(
    "href",
    "/auth/eve/link?grant=access-lists",
  );
  // The last successful observation still renders beneath the problem.
  await expect(page.getByRole("heading", { name: "Watched lists" })).toBeVisible();
  await expect(page.locator(".acl-list__row")).toContainText("Fleet staging");
});

test("states 4 and 5: a stale authorization and a dead token are different sentences", async ({
  page,
  context,
}) => {
  const reauth = await asAdmin(context, { tokenStatus: "needs_reauth" });
  await seedHolder(reauth.characterId);
  await seedCatalog(reauth.characterId);
  await page.goto("/admin/access-lists");
  await expect(page.locator(".lede")).toContainText("authorization has gone stale");
  await expect(page.getByRole("link", { name: "Re-authenticate" })).toBeVisible();

  await resetDb(db);
  const dead = await asAdmin(context, { tokenStatus: "missing" });
  await seedHolder(dead.characterId);
  await seedCatalog(dead.characterId);
  await page.goto("/admin/access-lists");
  await expect(page.locator(".lede")).toContainText("no stored token");
  await expect(
    page.getByRole("link", { name: "Add this character again" }),
  ).toBeVisible();
});
```

- [ ] **Step 5: Assert states 6 and 7, the clean row's missing toggle, and that it can still be unwatched**

```ts
test("state 6: a healthy holder with an empty catalog offers Check now as the primary", async ({
  page,
  context,
}) => {
  const { characterId } = await asAdmin(context);
  await seedHolder(characterId);
  await page.goto("/admin/access-lists");

  await expect(page.locator(".lede")).toContainText("No lists have been discovered");
  await expect(page.getByRole("button", { name: "Check now" })).toHaveClass(
    /btn--primary/,
  );
});

test("state 7: a clean list is one line with nothing to open", async ({
  page,
  context,
}) => {
  const { characterId } = await asAdmin(context);
  await seedHolder(characterId);
  await seedCatalog(characterId);
  // The one member character is listed explicitly, so nothing is missing and
  // nobody unexpected has access.
  const [member] = await db
    .select({ id: character.id })
    .from(character)
    .where(eq(character.name, "Vela Kaine"));
  await seedWatched(characterId, {
    entries: [{ kind: "character", entityId: member.id }],
  });
  await page.goto("/admin/access-lists");

  const row = page.locator(".acl-list__row");
  await expect(row).toContainText("in sync");
  // No disclosure control at all — not a closed one. A toggle over an empty
  // box is a promise the row cannot keep.
  await expect(row.locator("summary")).toHaveCount(0);

  // …but it is still removable. The row with no drawer is exactly the row an
  // admin most wants off the page, and for one revision of this design its
  // only "Stop watching" lived inside a drawer this row never renders — which
  // made a clean list permanently unwatchable. Asserted here, on the row that
  // has no `summary`, because that is the shape the bug hid in.
  await expect(row.getByRole("button", { name: "Stop watching" })).toBeVisible();
  await row.getByRole("button", { name: "Stop watching" }).click();
  await expect(page.locator(".notice")).toContainText("removed from the watchlist");
  await expect(page.locator(".acl-list__row")).toHaveCount(0);
  await expect(page.getByText("No lists are being watched yet.")).toBeVisible();
});
```

A never-read row takes the same branch: `rowHasDetail` is false for a row with
no snapshot too, so this one test covers both non-expanding shapes.

- [ ] **Step 6: Assert the drifted row's disclosure, its tone, and the drawer surviving its own control**

```ts
test("a drifted row opens to names, reads warn not bad, and its drawer survives Stop watching", async ({
  page,
  context,
}) => {
  const { characterId } = await asAdmin(context);
  await seedHolder(characterId);
  await seedCatalog(characterId);
  // Nobody from the roster is listed, and one stranger is: both buckets at once.
  await seedWatched(characterId, {
    entries: [{ kind: "character", entityId: 99_000_123 }],
  });
  await page.goto("/admin/access-lists");

  const row = page.locator(".acl-list__row");
  await expect(row).toContainText("1 missing access");
  await expect(row).toContainText("1 has access, not a member");
  // Drift is warn. `bad` is reserved for destructive acts and nothing this
  // page reports is one.
  await expect(row.locator(".st--warn")).toBeVisible();
  await expect(row.locator(".st--bad")).toHaveCount(0);

  const summary = row.locator("summary");
  await expect(summary).toHaveAttribute("aria-expanded", "false");
  await summary.click();
  await expect(summary).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("heading", { name: /Missing access \(1\)/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /not a member \(1\)/ })).toBeVisible();
  await expect(page.locator(".acl-detail")).toContainText("Vela Kaine");

  // The reason `removeWatchAction` returns an `ActionOutcome` instead of
  // redirecting: a redirect replaces the route tree and resets `Disclosure`'s
  // `useState`, closing this drawer on the press that used it. This assertion
  // is what would catch that regression.
  await page.getByRole("button", { name: "Stop watching" }).click();
  await expect(page.locator(".notice")).toContainText("removed from the watchlist");
  await expect(summary).toHaveAttribute("aria-expanded", "true");
});
```

- [ ] **Step 7: Assert the broad-grant partial count and the read-failure row**

```ts
test("a corporation grant states our count AND that it is partial", async ({
  page,
  context,
}) => {
  const { characterId } = await asAdmin(context);
  await seedHolder(characterId);
  await seedCatalog(characterId);
  await seedWatched(characterId, {
    entries: [{ kind: "corporation", entityId: 98_000_555 }],
  });
  await page.goto("/admin/access-lists");

  await page.locator(".acl-list__row summary").click();
  // We store a corporation per character and hold no corp roster, so the page
  // must never imply the second bucket is complete for a broad grant.
  await expect(page.locator(".acl-detail")).toContainText(
    "plus an unknown number of others",
  );
});

test("a failed read keeps the last good observation and dates it", async ({
  page,
  context,
}) => {
  const { characterId } = await asAdmin(context);
  await seedHolder(characterId);
  await seedCatalog(characterId);
  await seedWatched(characterId, {
    readStatus: "not_visible",
    entries: [{ kind: "character", entityId: 99_000_123 }],
  });
  await page.goto("/admin/access-lists");

  const row = page.locator(".acl-list__row");
  await expect(row).toContainText("not visible to holder");
  await expect(row.locator(".st--warn")).toBeVisible();
  await row.locator("summary").click();
  await expect(page.locator(".acl-detail .notice--warn")).toContainText(
    "last successful read",
  );
});

test("allow_everyone is stated in its own words, never as zero discrepancies", async ({
  page,
  context,
}) => {
  const { characterId } = await asAdmin(context);
  await seedHolder(characterId);
  await seedCatalog(characterId);
  await seedWatched(characterId, { allowEveryone: true });
  await page.goto("/admin/access-lists");

  const row = page.locator(".acl-list__row");
  await expect(row).toContainText("open to everyone");
  await expect(row).not.toContainText("in sync");
  await expect(row.locator(".st--warn")).toBeVisible();
});
```

- [ ] **Step 8: Assert Check now enqueues and writes no audit**

```ts
test("Check now enqueues a read and audits nothing", async ({ page, context }) => {
  const { characterId } = await asAdmin(context);
  await seedHolder(characterId);
  await seedCatalog(characterId);
  await page.goto("/admin/access-lists");

  await page.getByRole("button", { name: "Check now" }).click();
  await expect(page.locator(".notice")).toContainText("Check queued");

  const queued = await db.select().from(outbox);
  expect(queued).toHaveLength(1);
  // Enqueuing a READ changes no state, and `runJob` already records the run in
  // `sync_run`. An audit row here would be a state change that never happened.
  const audits = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.action, "access_list.check_requested"));
  expect(audits).toHaveLength(0);
});
```

Add `auditLog` and `outbox` to this file's `../src/db/schema` import.

- [ ] **Step 9: Update `e2e/shell.spec.ts` for the sixth nav item**

Three places assert the admin nav's exact contents and all three now fail:

- the route table at `:39` gains `["/admin/access-lists", "Access lists", "page"]`
- the two `toHaveText` arrays (~`:102-107`, ~`:121-126`) gain `"Access lists"`
  after `"Sync"`

Run: `npx playwright test e2e/shell.spec.ts`
Expected: green. A failure on `toHaveCount(1)` for `[aria-current]` means the new
route's `current` prop does not match its own `href` — check the page's
`SiteHeader` call passes `/admin/access-lists` exactly.

- [ ] **Step 10: Run the new spec alone**

Run: `npx playwright test e2e/access-lists.spec.ts`
Expected: all nine tests green. On a "not signed in" or "Something broke"
failure, first confirm no second e2e run is in flight in this worktree (see the
warning above) before reading the failure as a real one; re-run alone to
confirm.

- [ ] **Step 11: Format check**

Run: `npm run format:check`
On failure: `npm run format`.

- [ ] **Step 12: Commit**

```bash
git add e2e/access-lists.spec.ts e2e/helpers.ts e2e/shell.spec.ts
git commit -m "test(access-lists): end-to-end coverage for all seven page states"
```

---

### Task 12: Audit rendering, documentation, and the full gate

**Files:**

- Modify: `src/app/admin/audit/summarize.ts:239` (the `PARTS` registry) and
  `:107` (one new combinator beside `labelled`)
- Modify: `docs/ops.md:107-119` (the job schedule table — eight jobs today)
- Modify: `README.md:140-144` (the sync-jobs prose list), `README.md:128-129`
  (the admin-pages sentence), `README.md:228-232` (the SSO scope paragraph)
- Modify: `docs/settled-design-decisions.md` (append rows)
- Test: `tests/audit-summarize.test.ts` (append two cases); no new test file.
  This task also runs every existing gate.

**Interfaces:**

- Consumes: the four audit actions Task 6's service writes —
  `access_list.holder_designated` (`{characterId}`),
  `access_list.holder_replaced` (`{characterId, previousCharacterId}`),
  `access_list.watch_added` and `access_list.watch_removed`
  (`{accessListId, name: string | null}` — null when the list has left the
  catalog, which is the usual reason a watch is removed).
- Produces: nothing code imports.

- [ ] **Step 1: Confirm the doc locations before editing any of them**

Run:

```bash
grep -rn "discord-roles" README.md CONTRIBUTING.md PRODUCT.md AGENTS.md docs/*.md
grep -rn "EVE_SSO_SCOPES\|esi-characters.read_contacts" README.md docs/ops.md
grep -rn "admin pages (accounts" README.md
```

Expected today: the job list appears in exactly two places —
`docs/ops.md:111` (the table) and `README.md:140-144` (the prose); the scope
strings at `docs/ops.md:21`, `:397` and `README.md:230`; the admin-page list at
`README.md:129`. If any grep returns a file this task does not name, edit that
file too rather than skipping it — line numbers drift, the greps do not.

- [ ] **Step 2: Add the job to `docs/ops.md`'s schedule table**

After the `membership-recheck` row (`:116`), matching the file's own ordering of
sweep, then housekeeping/on-demand:

```markdown
| `access-lists` | `25 * * * *` | on-demand |
```

`:25` is a free slot — `:00/:30` membership, `:05` contacts, `:10` wanderer,
`:15` discord-roles, `:02,17,32,47` location.

The prose under the table says the 90-minute `/api/health/sync` threshold must
be revisited if the most frequent job goes slower. Hourly is not the most
frequent, so no change there; do not edit that paragraph.

- [ ] **Step 3: Add the job and the page to `README.md`**

The sync-jobs sentence (`:140-144`) currently ends "…a weekly affiliation
recheck, and a daily purge." Extend it to "…a weekly affiliation recheck, a
daily purge, and an hourly read-only access-list check."

The architecture bullet (`:129`) reads "admin pages (accounts, audit log, sync
status)". Make it "(accounts, audit log, sync status, access lists)".

- [ ] **Step 4: Document the scope WITHOUT adding it to `EVE_SSO_SCOPES`**

This is the step most likely to be got wrong by reflex. `esi-access.read_lists.v1`
is deliberately **not** in `EVE_SSO_SCOPES`: adding it flips every character to
`needs_reauth` at the next 03:00 token-health run, because that job compares
granted scopes against the required set. Do **not** append it to the scope
strings at `docs/ops.md:21`, `docs/ops.md:397`, or the README's paragraph.

Instead add a short subsection to `docs/ops.md`, immediately after "Adding an
SSO scope" (which ends at `:403`):

```markdown
### The access-list scope is opt-in

`esi-access.read_lists.v1` is deliberately **absent** from `EVE_SSO_SCOPES`.
Putting it there would flip every existing character to `needs_reauth` on the
next token-health run, for a feature only one character needs.

An admin grants it by visiting `/auth/eve/link?grant=access-lists`, which adds
the scope to that one authorization. Token-health checks that nothing required
is *missing*, not that the sets are equal, so a character carrying the extra
scope stays `valid`.

The grant is **not sticky**. Clicking any ordinary re-authentication link drops
it, and nothing prevents that — EVE's character picker runs after the authorize
URL is built, so at that moment there is no "the character" whose existing
scopes could be carried forward. `/admin/access-lists` detects the loss and asks
for a re-grant rather than failing silently.
```

- [ ] **Step 5: Record the settled decisions**

Append to the table in `docs/settled-design-decisions.md`:

```markdown
| The access-list scope stays out of `EVE_SSO_SCOPES` | Adding it flips every character to `needs_reauth` at the next token-health run, because that job compares granted scopes against the required set | `docs/specs/2026-08-09-access-list-monitor-design.md`, `src/jobs/token-health.ts` |
| A dropped ACL scope outranks a bad token in the page's state cascade | A holder that re-authenticated through the ordinary link has a `valid` token AND no scope; offering the plain re-auth link first sends the admin round the loop that caused it | `src/app/admin/access-lists/view.ts` (`monitorState`) |
| Access-list drift is `warn`, never `bad` | `bad` is reserved for destructive acts, and every row on this page is a read of a list only a human can change in-game | `src/app/admin/access-lists/view.ts` (`rowTone`) |
| `removeWatchAction` returns an `ActionOutcome` instead of redirecting | Its control sits inside a `Disclosure`; a redirect replaces the route tree and resets that `useState`, closing the drawer on the press that used it — caught twice before on two other pages | `src/app/admin/access-lists/actions.ts` |
```

- [ ] **Step 6: Write the failing audit-summary tests**

The four actions Task 6 writes have no entry in `/admin/audit`'s renderer, so
today they fall through to the generic `key=value` fallback. Append to
`tests/audit-summarize.test.ts`, inside the existing
`describe("summarizeDetails")`:

```ts
  it("renders an access-list holder designation and its replacement", () => {
    expect(
      summarizeDetails("access_list.holder_designated", { characterId: 90000001 }),
    ).toBe("character 90000001");
    expect(
      summarizeDetails("access_list.holder_replaced", {
        characterId: 90000002,
        previousCharacterId: 90000001,
      }),
    ).toBe("character 90000002, was 90000001");
  });

  it("renders a watch change with the list's name, and without it", () => {
    expect(
      summarizeDetails("access_list.watch_added", {
        accessListId: 580356,
        name: "Home Fleet",
      }),
    ).toBe("Home Fleet (580356)");
    // A list can be watched before any discovery has named it. The id alone is
    // the honest rendering; `?` would read as a failure rather than a not-yet.
    expect(
      summarizeDetails("access_list.watch_removed", {
        accessListId: 580356,
        name: null,
      }),
    ).toBe("580356");
  });
```

- [ ] **Step 7: Run them and watch them fail**

Run: `npx vitest run tests/audit-summarize.test.ts`

Expected: FAIL — the first gets `characterId=90000001` from the fallback, the
second `accessListId=580356, name=Home Fleet`.

- [ ] **Step 8: Register the four actions**

Add the combinator to `src/app/admin/audit/summarize.ts`, beside the other
builders (after `labelled`, around `:107`):

```ts
/** `Home Fleet (580356)`, or the bare id when the payload carried no name. A
 * list can be watched before the first discovery names it, and a list that went
 * invisible has no catalog row — both write `name: null`, and `fmt`'s `?` would
 * read as a failure rather than a not-yet. Declares both keys so the missing
 * name does not surface as a `+1 more`. */
function accessListRef(nameKey: string, idKey: string): Part {
  return part([nameKey, idKey], (d) => {
    const id = d[idKey] === undefined ? "" : fmt(d[idKey]);
    const name = typeof d[nameKey] === "string" ? d[nameKey] : "";
    if (!id) return name;
    return name ? `${name} (${id})` : id;
  });
}
```

Then add four entries to `PARTS` (`:239`), after the `character.*` block:

```ts
  "access_list.holder_designated": [labelled("character", "characterId")],
  "access_list.holder_replaced": [
    labelled("character", "characterId"),
    labelled("was", "previousCharacterId"),
  ],
  "access_list.watch_added": [accessListRef("name", "accessListId")],
  "access_list.watch_removed": [accessListRef("name", "accessListId")],
```

Do not add any of them to `isFailureAction` — none is a failure; the two watch
actions are ordinary admin edits and the holder ones are grants.

- [ ] **Step 9: Run them and watch them pass**

Run: `npx vitest run tests/audit-summarize.test.ts`

Expected: PASS, the whole file green — the existing cases must not move.

- [ ] **Step 10: Gate — formatting**

Run: `npm run format:check`
On failure: `npm run format`, then re-run and inspect the diff — Prettier
reflows markdown tables, and a table it rewrote is worth reading before it is
committed.

- [ ] **Step 11: Gate — types**

Run: `npm run typecheck`
On failure: fix at the source. Do not add `as` casts or `@ts-expect-error` to
clear this gate; a type error here is usually a real disagreement between the
new tables' inferred types and the view's hand-written unions.

- [ ] **Step 12: Gate — lint**

Run: `npm run lint`

`typecheck`, `lint` and `format:check` are ONE CI job (CONTRIBUTING.md:31-33) —
any one of them red fails the whole thing, so a green typecheck proves a third
of it. The likely findings on this feature are unused imports left behind while
iterating on `page.tsx`, and a floating promise on an `enqueueSync` call whose
`await` went missing.

- [ ] **Step 13: Gate — unit tests**

Run: `npm test`
On failure: read the failing file first. If the failures are broad and land in
suites this feature never touched, the cause is usually stale `node_modules`
rather than this change — run `npm ci` and re-run before debugging. Compare the
number of test *files* reported against the previous run: a load failure
silently drops whole files, which looks like a smaller-but-passing suite.

- [ ] **Step 14: Gate — end-to-end**

Run: `npm run test:e2e`
One run at a time in this worktree. On failure, re-run the single failing spec
before treating it as real:
`npx playwright test e2e/access-lists.spec.ts --reporter=json`.
No `reporter` is configured, so the default `list` discards `testInfo.attach`
bodies and leaves `test-results/` empty — pass `--reporter=json` (skip to the
first `{`) or `--reporter=html` when a trace or attachment is needed.

- [ ] **Step 15: Gate — production build**

Run: `npm run build`
This is a separate gate, not a formality after e2e: local e2e runs `next dev`
while CI runs a production build, so a page that renders fine under `npm run
test:e2e` can still fail the build job. The usual cause on a new page is a
server/client boundary — a `"use client"` module's export called from a server
component, or a client component handed a non-serializable prop.

- [ ] **Step 16: Gate — Node version**

Run: `./scripts/check-node-version.sh`
This file exists at that exact path. On failure, match `.nvmrc` to the major
`package.json` `engines` declares (`>=24`) — pin the MAJOR only; pinning a minor
breaks every CI job at `npm ci`.

- [ ] **Step 17: Confirm the tree is clean, and specifically that e2e left nothing behind**

Run:

```bash
git status --porcelain
git diff --stat tsconfig.json AGENTS.md
```

Expected: no output from either. Running e2e rewrites `tsconfig.json` and
`AGENTS.md`. **Both files are TRACKED**, so the fix is
`git checkout -- tsconfig.json AGENTS.md` — never deletion, which would remove
real repository files. Any other untracked path (a stray `implementation-notes.md`,
a scratch probe file, `test-results/`) must be removed or committed
deliberately; note that `cp` and `rm` are aliased to prompt in this environment
and exit without acting, so use `/bin/rm -f` for scratch files.

- [ ] **Step 18: Gate — Docker build**

Run: `docker build .`

The fifth CI job, and one this feature can uniquely fail. `.dockerignore` prunes
the build context, so a file that reaches into a pruned directory typechecks
clean on every PR and only breaks at deploy (CONTRIBUTING.md:36-38). This change
adds a migration under `drizzle/` and a new page tree, both of which must reach
the image — `fly.toml` runs migrations as a release command on every deploy, so
a `drizzle/` file missing from the context fails production rather than CI.

On failure, check `.dockerignore` before touching any source: the fix is almost
always the ignore rule, not the import.

- [ ] **Step 19: Commit**

```bash
git add README.md docs/ops.md docs/settled-design-decisions.md \
        src/app/admin/audit/summarize.ts tests/audit-summarize.test.ts
git commit -m "docs(access-lists): the new job, page, and the opt-in scope"
```

---

## Choices the plan made that the spec left open

Three judgment calls are written into the tasks above rather than left to the
implementer. Each is cheap to reverse, and each is recorded here so reversing it
is a decision rather than a drift.

1. **A watched list the job has never reached renders `off`, not `warn`**
   (Task 9, `rowTone`). The spec's tone table has no row for "no snapshot yet",
   and `sync/view.ts` gives its `never` state the same treatment: nothing is
   wrong, nothing has happened. Changing it to `warn` touches `rowTone` and one
   test.
2. **`description: null` from ESI becomes `""`** (Task 2). The parser is
   `.nullish()` and maps null to empty, which keeps `EsiAccessList.description`
   a plain `string`. A consumer cannot distinguish "no description" from "empty
   description" — nothing in this feature needs to.
3. **No route-level test for `src/app/auth/eve/link/route.ts`** (Task 8). No
   existing test drives that route. The new behaviour is covered indirectly
   (`buildEveAuthorizeUrl` is unit-tested and the scope is a constant) and
   directly by Task 11's e2e spec, which follows the grant link. A route-level
   test, if wanted, belongs in a new `tests/eve-link-route.test.ts`.

