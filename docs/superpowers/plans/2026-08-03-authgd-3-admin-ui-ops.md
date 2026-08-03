# authGD Plan 3/3: Admin UI & Ops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The admin surface (accounts page with tier/lock/cryo controls, audit log, sync status + "sync now"), admin-gated routes and admin management, deployment to Fly.io (one image, web + worker processes, migrate on release), operator docs, a live Wanderer smoke script, Playwright smoke tests, the deferred Plan 2 findings (F5 CAS, F6 User-Agent, F7 recheck labeling, testJwksOverride retirement), and the Plan 2 post-merge review findings that arrived after PR #2 merged (queue-config repair on restart, retryable dead-letter alerts, membership-run write race, affiliation response validation, Discord 404 error-code mapping — Tasks 13–15).

**Architecture:** Admin mutations live in services (`src/services/accounts.ts`, new `src/services/admin-accounts.ts`) taking `DbTx` + an `actor`, with defense-in-depth authorization inside the service and audit + outbox rows committed in the same transaction — exactly the Plan 1/2 convention. Read models extend `src/services/account-view.ts` (member view untouched; a new bulk admin query beside it). Pages are server components under `src/app/admin/*` gated per-page by a session→is_admin guard; every server action re-gates independently (layouts do not protect actions). Sort/filter is searchParams-driven and computed in memory (~20 accounts). Deployment: multi-stage Dockerfile producing one image with the standalone Next server (web process) and tsx-run worker/migrate (worker process, release command), wired by `fly.toml`.

**Tech Stack:** Next.js 15 App Router (server components + server actions, no client JS added), Drizzle + Postgres 16, vitest + msw, @playwright/test (new devDep), Fly.io.

**Spec:** `docs/superpowers/specs/2026-08-02-authgd-design.md` — authoritative ("UI", tier state machine, admin/audit requirements).
**Carry-over:** `docs/superpowers/plans/2026-08-02-authgd-plan2-3-carryover.md` ("Plan 3 notes").
**Consumed interfaces:** Plan 2 (`…-authgd-2-sync-engine.md`) Tasks 2/6/13; Plan 1 for session/services.

## Global Constraints

- Plan 1/2 Global Constraints still apply: strict TS, no `any`, DbTx-only identity mutations, audit rows for state changes, conventional commits after every green cycle, `npm test` needs the dev-compose Postgres on port 5433 (`docker compose -f docker-compose.dev.yml up -d`; a compose project named `authgd-design` may already own port 5433 — reuse it, don't fight it).
- **Every admin mutation:** actor authorization checked inside the service (defense in depth — routes gate too), account row locked `FOR UPDATE` and re-checked, audit row + `outbox` row (where the change affects derived sets) written in the SAME `db.transaction`. Server actions NEVER call `db.update` directly — they call services.
- **Admin gating:** every `/admin` page calls the guard itself and `redirect`s; every admin server action calls `requireAdminAction()` first. Layouts are navigation chrome only — Next.js does not re-run a layout on soft navigation and layouts never run for server actions, so they must not be the security boundary.
- **The "Map" column reads `wanderer_acl_observation` only** (observed membership + `observed_at`), never inferred state.
- **"Sync now" writes `outbox` rows** (`{kind:"all"}` global, `{kind:"account"}` per account) — never touches pg-boss tables; the Plan 2 dispatcher already handles both. The one new payload kind added here (`{kind:"membership-recheck"}`, spec's admin recheck button) goes through the same outbox → `planDispatch` path.
- Tier semantics (spec state machine): ANY manual tier set (flygd/blue/green) sets `tier_locked = true`; "return to auto" clears the lock only — the next membership run stamps the tier. Manual changes record `tier_changed_by = <actor account id>`.
- UI conventions: match existing pages — server components, inline styles, plain HTML forms bound to server actions (`action={fn.bind(null, …)}`), `<details>` for expandable content, `export const dynamic = "force-dynamic"` on every session-reading page, errors surfaced via `?error=` searchParams with `role="alert"`.
- Tests: table-driven vitest for pure logic; integration tests against `TEST_DATABASE_URL` via `tests/helpers/db.ts` (`setupTestDb`, `truncateAll`); msw for HTTP. Pages themselves are covered by typecheck + Playwright (Task 12), not vitest — matching the existing repo (route handlers are tested, `page.tsx` files are not).
- Playwright e2e lives in `e2e/` (vitest `include` is `tests/**` so the suites can't collide); e2e runs against the dev server on port 3111 + the test database. Never run `npm test` and `npm run test:e2e` simultaneously (shared test DB).
- New env var `ESI_CONTACT` (Task 8) is REQUIRED — update `tests/helpers/config.ts` and every place that builds env (Playwright webServer, docs, fly secrets) in the same task that introduces it.

## File structure (new/modified)

| File | Responsibility |
|---|---|
| `src/services/accounts.ts` | + `promoteAdmin`; `demoteAdmin` gets `ORDER BY account.id` |
| `src/services/admin-accounts.ts` (new) | admin tier/lock/status/note mutations |
| `src/services/account-view.ts` | + `getAdminAccountsList` (member view untouched) |
| `src/services/audit.ts` | + `queryAuditLog` |
| `src/services/sync-status.ts` (new) | grouped `sync_run` read model |
| `src/lib/admin-guard.ts` (new) | `resolveAdmin` (testable core) + cookie wrappers |
| `src/app/admin/{layout,accounts,audit,sync}` (new) | admin pages + actions |
| `src/jobs/{contacts,membership}.ts`, `src/lib/esi/client.ts`, `src/lib/esi/sso.ts`, `src/jobs/token-health.ts`, `src/config.ts`, `src/worker/{index,dispatcher}.ts`, `src/services/outbox.ts` (type only via schema) | F5/F6/F7, jwks DI, recheck payload |
| `Dockerfile`, `.dockerignore`, `fly.toml`, `docs/ops.md`, `scripts/wanderer-smoke.ts` | deployment + ops |
| `playwright.config.ts`, `e2e/*` | smoke tests |
| `src/worker/queues.ts`, `src/lib/ops-webhook.ts`, `src/worker/index.ts` | post-merge: queue repair, retryable dead-letter alert |
| `src/core/affiliation.ts`, `src/jobs/membership.ts` | post-merge: response validation, stale-write CAS |
| `src/lib/discord/rest.ts` | post-merge: 404 → null only for code 10007 |

---

### Task 1: `promoteAdmin` + `demoteAdmin` lock ordering (carry-over)

Carry-over: `demoteAdmin`'s multi-row `FOR UPDATE` needs `ORDER BY account.id` (deterministic lock order). The admin-management UI also needs a `promoteAdmin` service (grant is_admin) that doesn't exist yet.

**Files:**
- Modify: `src/services/accounts.ts` (demoteAdmin ~line 375; add promoteAdmin after it)
- Test: `tests/accounts.test.ts` (append a describe block)

**Interfaces:**
- Consumes: existing `account` table, `logAudit`.
- Produces: `promoteAdmin(dbx: DbTx, actor: string, accountId: string): Promise<{ ok: boolean; error?: "not_authorized" | "not_found" }>` — actor must be `"system"` or a current admin; locks the admin set (sorted) then the target row; idempotent (already-admin target → ok, no audit row); audits `admin.promoted`. `demoteAdmin` keeps its exact signature/behavior, now with ordered locking. Task 5's actions consume both.

- [ ] **Step 1: Write failing tests** — append to `tests/accounts.test.ts` (it already has `setupTestDb`/seed imports and a `demoteAdmin` describe; follow its local patterns for creating accounts):

```ts
describe("promoteAdmin", () => {
  it("lets an admin grant is_admin, audit-logged", async () => {
    const admin = await seedAccount(ctx.db);
    await ctx.db.update(account).set({ isAdmin: true }).where(eq(account.id, admin.id));
    const target = await seedAccount(ctx.db);
    const result = await ctx.db.transaction((tx) => promoteAdmin(tx, admin.id, target.id));
    expect(result).toEqual({ ok: true });
    const [after] = await ctx.db.select().from(account).where(eq(account.id, target.id));
    expect(after.isAdmin).toBe(true);
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "admin.promoted"));
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe(admin.id);
    expect(rows[0].target).toBe(target.id);
  });

  it("rejects a non-admin actor", async () => {
    const nobody = await seedAccount(ctx.db);
    const target = await seedAccount(ctx.db);
    const result = await ctx.db.transaction((tx) => promoteAdmin(tx, nobody.id, target.id));
    expect(result).toEqual({ ok: false, error: "not_authorized" });
  });

  it("is idempotent for an already-admin target (no duplicate audit)", async () => {
    const admin = await seedAccount(ctx.db);
    await ctx.db.update(account).set({ isAdmin: true }).where(eq(account.id, admin.id));
    await ctx.db.transaction((tx) => promoteAdmin(tx, admin.id, admin.id));
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "admin.promoted"));
    expect(rows).toHaveLength(0);
  });

  it("returns not_found for a missing target", async () => {
    const admin = await seedAccount(ctx.db);
    await ctx.db.update(account).set({ isAdmin: true }).where(eq(account.id, admin.id));
    const result = await ctx.db.transaction((tx) =>
      promoteAdmin(tx, admin.id, "00000000-0000-0000-0000-000000000000"),
    );
    expect(result).toEqual({ ok: false, error: "not_found" });
  });
});
```

Add `promoteAdmin` to the existing `@/services/accounts` import and (if not present) `auditLog` to the schema import in that test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/accounts.test.ts`
Expected: FAIL — `promoteAdmin` is not exported.

- [ ] **Step 3: Implement** — in `src/services/accounts.ts`, add `asc` to the drizzle-orm import, change `demoteAdmin`'s admin query to:

```ts
  const admins = await dbx
    .select()
    .from(account)
    .where(eq(account.isAdmin, true))
    .orderBy(asc(account.id))
    .for("update");
```

and append after `demoteAdmin`:

```ts
export async function promoteAdmin(
  dbx: DbTx,
  actor: string,
  accountId: string,
): Promise<{ ok: boolean; error?: "not_authorized" | "not_found" }> {
  // Same lock order as demoteAdmin: the sorted admin set first, so concurrent
  // promote/demote serialize on it, then the (non-admin) target row.
  const admins = await dbx
    .select()
    .from(account)
    .where(eq(account.isAdmin, true))
    .orderBy(asc(account.id))
    .for("update");
  if (actor !== "system" && !admins.some((a) => a.id === actor)) {
    return { ok: false, error: "not_authorized" };
  }
  const [target] = await dbx
    .select()
    .from(account)
    .where(eq(account.id, accountId))
    .for("update");
  if (!target) return { ok: false, error: "not_found" };
  if (!target.isAdmin) {
    await dbx.update(account).set({ isAdmin: true }).where(eq(account.id, accountId));
    await logAudit(dbx, { actor, action: "admin.promoted", target: accountId });
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- tests/accounts.test.ts`
Expected: PASS (including all pre-existing demoteAdmin cases).

- [ ] **Step 5: Commit**

```bash
git add src/services/accounts.ts tests/accounts.test.ts
git commit -m "feat: promoteAdmin service + ordered admin-row locking in demoteAdmin"
```

---

### Task 2: Admin account mutation service (tier / lock / cryo / notes)

**Files:**
- Create: `src/services/admin-accounts.ts`
- Test: `tests/admin-accounts.test.ts`

**Interfaces:**
- Consumes: `account` table, `logAudit`, `enqueueSync`, `DbTx`.
- Produces (all check the actor is `"system"` or a current admin; all lock the target row FOR UPDATE; Task 5's actions consume these):
  - `type AdminMutationResult = { ok: true } | { ok: false; error: "not_authorized" | "not_found" }`
  - `setTierManual(dbx: DbTx, actor: string, accountId: string, tier: "flygd" | "blue" | "green"): Promise<AdminMutationResult>` — sets tier + `tierLocked: true` + `tierChangedAt`/`tierChangedBy: actor`; audit `tier.changed` `{ to, locked: true, cause: "manual" }`; `enqueueSync({kind:"account"})` — one transaction. No-op (no audit/outbox) when already locked at that tier.
  - `returnTierToAuto(dbx, actor, accountId): Promise<AdminMutationResult>` — clears `tierLocked` ONLY (tier/changedAt untouched — the next membership run stamps them); audit `tier.unlocked`; `enqueueSync({kind:"account"})` so membership converges promptly. No-op when already unlocked.
  - `setAccountStatus(dbx, actor, accountId, status: "active" | "cryo"): Promise<AdminMutationResult>` — sets status + `statusChangedAt`; audit `status.changed` `{ to }`; `enqueueSync({kind:"account"})`. No-op when unchanged.
  - `setStatusNote(dbx, actor, accountId, note: string): Promise<AdminMutationResult>` — trims; empty → `null`; audit `status.note_changed`; NO outbox (notes feed no derived set). No-op when unchanged.

- [ ] **Step 1: Write failing tests** — `tests/admin-accounts.test.ts`:

```ts
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { account, auditLog, outbox } from "@/db/schema";
import {
  returnTierToAuto,
  setAccountStatus,
  setStatusNote,
  setTierManual,
} from "@/services/admin-accounts";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedAccount } from "./helpers/seed";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

async function seedAdmin() {
  const acc = await seedAccount(ctx.db);
  await ctx.db.update(account).set({ isAdmin: true }).where(eq(account.id, acc.id));
  return acc;
}
const getAcc = async (id: string) =>
  (await ctx.db.select().from(account).where(eq(account.id, id)))[0];
const outboxRows = () => ctx.db.select().from(outbox);
const lastAudit = async () =>
  (await ctx.db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(1))[0];

describe("setTierManual", () => {
  it("sets tier, locks, stamps changed-by, audits, and enqueues sync in one tx", async () => {
    const admin = await seedAdmin();
    const target = await seedAccount(ctx.db, { tier: "flygd" });
    const r = await ctx.db.transaction((tx) => setTierManual(tx, admin.id, target.id, "blue"));
    expect(r).toEqual({ ok: true });
    const after = await getAcc(target.id);
    expect(after.tier).toBe("blue");
    expect(after.tierLocked).toBe(true);
    expect(after.tierChangedBy).toBe(admin.id);
    expect(after.tierChangedAt).not.toBeNull();
    const audit = await lastAudit();
    expect(audit.action).toBe("tier.changed");
    expect(audit.actor).toBe(admin.id);
    expect(audit.details).toMatchObject({ to: "blue", locked: true, cause: "manual" });
    expect(await outboxRows()).toHaveLength(1);
  });

  it("locking at the SAME tier is still a change (green → locked green)", async () => {
    const admin = await seedAdmin();
    const target = await seedAccount(ctx.db, { tier: "green" });
    await ctx.db.transaction((tx) => setTierManual(tx, admin.id, target.id, "green"));
    const after = await getAcc(target.id);
    expect(after.tierLocked).toBe(true);
    expect(await outboxRows()).toHaveLength(1);
  });

  it("is a no-op when already locked at that tier", async () => {
    const admin = await seedAdmin();
    const target = await seedAccount(ctx.db, { tier: "blue", tierLocked: true });
    await ctx.db.transaction((tx) => setTierManual(tx, admin.id, target.id, "blue"));
    expect(await outboxRows()).toHaveLength(0);
    expect(await lastAudit()).toBeUndefined();
  });

  it("rejects non-admin actors", async () => {
    const nobody = await seedAccount(ctx.db);
    const target = await seedAccount(ctx.db);
    const r = await ctx.db.transaction((tx) => setTierManual(tx, nobody.id, target.id, "blue"));
    expect(r).toEqual({ ok: false, error: "not_authorized" });
  });
});

describe("returnTierToAuto", () => {
  it("clears the lock only — tier and changed-at untouched — audits, enqueues", async () => {
    const admin = await seedAdmin();
    const target = await seedAccount(ctx.db, { tier: "blue", tierLocked: true });
    const before = await getAcc(target.id);
    await ctx.db.transaction((tx) => returnTierToAuto(tx, admin.id, target.id));
    const after = await getAcc(target.id);
    expect(after.tierLocked).toBe(false);
    expect(after.tier).toBe("blue"); // membership job converges it later
    expect(after.tierChangedAt).toEqual(before.tierChangedAt);
    expect((await lastAudit()).action).toBe("tier.unlocked");
    expect(await outboxRows()).toHaveLength(1);
  });

  it("is a no-op when already unlocked", async () => {
    const admin = await seedAdmin();
    const target = await seedAccount(ctx.db);
    await ctx.db.transaction((tx) => returnTierToAuto(tx, admin.id, target.id));
    expect(await outboxRows()).toHaveLength(0);
  });
});

describe("setAccountStatus / setStatusNote", () => {
  it("cryo toggle stamps the date, audits, and enqueues", async () => {
    const admin = await seedAdmin();
    const target = await seedAccount(ctx.db);
    await ctx.db.transaction((tx) => setAccountStatus(tx, admin.id, target.id, "cryo"));
    const after = await getAcc(target.id);
    expect(after.status).toBe("cryo");
    expect(after.statusChangedAt).not.toBeNull();
    expect((await lastAudit()).details).toMatchObject({ to: "cryo" });
    expect(await outboxRows()).toHaveLength(1);
  });

  it("status no-op when unchanged", async () => {
    const admin = await seedAdmin();
    const target = await seedAccount(ctx.db);
    await ctx.db.transaction((tx) => setAccountStatus(tx, admin.id, target.id, "active"));
    expect(await outboxRows()).toHaveLength(0);
  });

  it("note is trimmed, empty clears to null, audited, NO outbox row", async () => {
    const admin = await seedAdmin();
    const target = await seedAccount(ctx.db);
    await ctx.db.transaction((tx) => setStatusNote(tx, admin.id, target.id, "  back in Oct  "));
    expect((await getAcc(target.id)).statusNote).toBe("back in Oct");
    expect((await lastAudit()).action).toBe("status.note_changed");
    await ctx.db.transaction((tx) => setStatusNote(tx, admin.id, target.id, "   "));
    expect((await getAcc(target.id)).statusNote).toBeNull();
    expect(await outboxRows()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/admin-accounts.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — `src/services/admin-accounts.ts`:

```ts
import { eq } from "drizzle-orm";
import type { DbTx } from "@/db";
import { account } from "@/db/schema";
import { logAudit } from "@/services/audit";
import { enqueueSync } from "@/services/outbox";

export type AdminMutationResult =
  | { ok: true }
  | { ok: false; error: "not_authorized" | "not_found" };

/** Defense in depth: routes gate too, but services refuse unauthorized actors. */
async function isAuthorized(dbx: DbTx, actor: string): Promise<boolean> {
  if (actor === "system") return true;
  const [a] = await dbx.select().from(account).where(eq(account.id, actor));
  return a?.isAdmin === true;
}

async function lockTarget(dbx: DbTx, accountId: string) {
  const rows = await dbx
    .select()
    .from(account)
    .where(eq(account.id, accountId))
    .for("update");
  return rows[0];
}

/**
 * Spec tier state machine: ANY manual set (flygd, blue, or green) locks the
 * account — the membership job never touches locked accounts. Change + audit
 * + outbox commit in one transaction (the caller supplies the DbTx).
 */
export async function setTierManual(
  dbx: DbTx,
  actor: string,
  accountId: string,
  tier: "flygd" | "blue" | "green",
): Promise<AdminMutationResult> {
  if (!(await isAuthorized(dbx, actor))) return { ok: false, error: "not_authorized" };
  const acc = await lockTarget(dbx, accountId);
  if (!acc) return { ok: false, error: "not_found" };
  if (acc.tier === tier && acc.tierLocked) return { ok: true };
  await dbx
    .update(account)
    .set({ tier, tierLocked: true, tierChangedAt: new Date(), tierChangedBy: actor })
    .where(eq(account.id, accountId));
  await logAudit(dbx, {
    actor,
    action: "tier.changed",
    target: accountId,
    details: { to: tier, locked: true, cause: "manual" },
  });
  await enqueueSync(dbx, { kind: "account", accountId });
  return { ok: true };
}

/**
 * Clears the lock ONLY. The tier itself is stamped by the next membership run
 * (enqueued here), keeping "system decided" provenance in tier_changed_by.
 */
export async function returnTierToAuto(
  dbx: DbTx,
  actor: string,
  accountId: string,
): Promise<AdminMutationResult> {
  if (!(await isAuthorized(dbx, actor))) return { ok: false, error: "not_authorized" };
  const acc = await lockTarget(dbx, accountId);
  if (!acc) return { ok: false, error: "not_found" };
  if (!acc.tierLocked) return { ok: true };
  await dbx.update(account).set({ tierLocked: false }).where(eq(account.id, accountId));
  await logAudit(dbx, { actor, action: "tier.unlocked", target: accountId });
  await enqueueSync(dbx, { kind: "account", accountId });
  return { ok: true };
}

export async function setAccountStatus(
  dbx: DbTx,
  actor: string,
  accountId: string,
  status: "active" | "cryo",
): Promise<AdminMutationResult> {
  if (!(await isAuthorized(dbx, actor))) return { ok: false, error: "not_authorized" };
  const acc = await lockTarget(dbx, accountId);
  if (!acc) return { ok: false, error: "not_found" };
  if (acc.status === status) return { ok: true };
  await dbx
    .update(account)
    .set({ status, statusChangedAt: new Date() })
    .where(eq(account.id, accountId));
  await logAudit(dbx, {
    actor,
    action: "status.changed",
    target: accountId,
    details: { to: status },
  });
  await enqueueSync(dbx, { kind: "account", accountId });
  return { ok: true };
}

export async function setStatusNote(
  dbx: DbTx,
  actor: string,
  accountId: string,
  note: string,
): Promise<AdminMutationResult> {
  if (!(await isAuthorized(dbx, actor))) return { ok: false, error: "not_authorized" };
  const acc = await lockTarget(dbx, accountId);
  if (!acc) return { ok: false, error: "not_found" };
  const value = note.trim() || null;
  if (acc.statusNote === value) return { ok: true };
  await dbx.update(account).set({ statusNote: value }).where(eq(account.id, accountId));
  await logAudit(dbx, { actor, action: "status.note_changed", target: accountId });
  return { ok: true };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- tests/admin-accounts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/admin-accounts.ts tests/admin-accounts.test.ts
git commit -m "feat: admin tier/lock/cryo/note mutations with audit + outbox"
```

---

### Task 3: Admin accounts list read model

**Files:**
- Modify: `src/services/account-view.ts` (append — `getAccountView` untouched)
- Test: `tests/account-view.test.ts` (append)

**Interfaces:**
- Consumes: schema tables, `Config` (`cfg.eveSso.scopes` for the needs-reauth computation, same rule as `getAccountView`).
- Produces (Task 5 renders this; ~20 accounts, so filter/sort happens in memory):

```ts
export interface AdminCharacterRow {
  id: number;
  name: string;
  isMain: boolean;
  tokenStatus: "valid" | "invalid" | "needs_reauth" | "missing";
  needsReauthForScopes: boolean;
  affiliationInvalid: boolean;
  contactSyncResult: string | null;
  mapObservedAt: Date | null; // from wanderer_acl_observation — never inferred
}
export interface AdminAccountRow {
  accountId: string;
  isAdmin: boolean;
  tier: "flygd" | "blue" | "green";
  tierLocked: boolean;
  tierChangedAt: Date | null;
  tierChangedByName: string | null; // "system" | actor's main-char name | raw id
  status: "active" | "cryo";
  statusChangedAt: Date | null;
  statusNote: string | null;
  lastLoginAt: Date | null;
  mainName: string | null; // null = "no main"
  discordLinked: boolean;
  characters: AdminCharacterRow[];
  tokenSummary: { total: number; healthy: number; needsReauth: number; dead: number };
  mapCount: number;
}
export type AdminListSort = "name" | "tier" | "status" | "tierChangedAt";
export interface AdminListFilters {
  tier?: "flygd" | "blue" | "green";
  status?: "active" | "cryo";
  sort?: AdminListSort;   // default "name"
  dir?: "asc" | "desc";   // default "asc"
}
export async function getAdminAccountsList(
  dbx: Dbx, cfg: Config, filters?: AdminListFilters,
): Promise<AdminAccountRow[]>
```

  - `tokenSummary`: `healthy` = tokenStatus valid AND full scope coverage; `needsReauth` = needs_reauth status OR scope shortfall; `dead` = invalid/missing.
  - `tierChangedByName`: `"system"` stays `"system"`; an account id resolves to that account's main character name; unresolvable ids fall back to the raw id.
  - Sort: `name` = mainName case-insensitive, accounts with no main last; `tier` by rank flygd(0) < blue(1) < green(2); `status` active(0) < cryo(1); `tierChangedAt` nulls last. `dir: "desc"` reverses. Ties keep name order.

- [ ] **Step 1: Write failing tests** — append to `tests/account-view.test.ts` (reuse its existing `ctx`/`cfg`/seed setup; add needed imports: `getAdminAccountsList`, `wandererAclObservation`, `account`, `character`):

```ts
describe("getAdminAccountsList", () => {
  async function seedTrio() {
    // A: flygd, main "Alpha" + alt, on map, discord linked
    const a = await seedAccount(ctx.db, { tier: "flygd", discordUserId: "111" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: a.id, main: true, name: "Alpha" });
    await seedCharacter(ctx.db, cfg, { id: 2, accountId: a.id, name: "Alpha Alt" });
    await ctx.db.insert(wandererAclObservation).values({
      characterId: 1, role: "viewer", observedAt: new Date("2026-08-01T00:00:00Z"),
    });
    // B: green + cryo, main "Beta"
    const b = await seedAccount(ctx.db, { tier: "green" });
    await seedCharacter(ctx.db, cfg, { id: 3, accountId: b.id, main: true, name: "Beta" });
    await ctx.db.update(account)
      .set({ status: "cryo", statusChangedAt: new Date(), statusNote: "afk" })
      .where(eq(account.id, b.id));
    // C: locked blue, set by A, main "Gamma"
    const c = await seedAccount(ctx.db, { tier: "blue", tierLocked: true });
    await seedCharacter(ctx.db, cfg, { id: 4, accountId: c.id, main: true, name: "Gamma" });
    await ctx.db.update(account)
      .set({ tierChangedAt: new Date("2026-07-01T00:00:00Z"), tierChangedBy: a.id })
      .where(eq(account.id, c.id));
    return { a, b, c };
  }

  it("assembles rows: map from observations, discord, lock, resolved changed-by", async () => {
    const { a, c } = await seedTrio();
    const rows = await getAdminAccountsList(ctx.db, cfg);
    const rowA = rows.find((r) => r.accountId === a.id)!;
    expect(rowA.mainName).toBe("Alpha");
    expect(rowA.discordLinked).toBe(true);
    expect(rowA.mapCount).toBe(1);
    expect(rowA.characters.find((ch) => ch.id === 1)?.mapObservedAt).toEqual(
      new Date("2026-08-01T00:00:00Z"),
    );
    expect(rowA.characters.find((ch) => ch.id === 2)?.mapObservedAt).toBeNull();
    const rowC = rows.find((r) => r.accountId === c.id)!;
    expect(rowC.tierLocked).toBe(true);
    expect(rowC.tierChangedByName).toBe("Alpha"); // resolved to actor's main
  });

  it("defaults to name sort with no-main accounts last — in BOTH directions", async () => {
    await seedTrio();
    const noMain = await seedAccount(ctx.db, { tier: "green" }); // zero characters
    const rows = await getAdminAccountsList(ctx.db, cfg);
    expect(rows.map((r) => r.mainName)).toEqual(["Alpha", "Beta", "Gamma", null]);
    expect(rows[3].accountId).toBe(noMain.id);
    const descRows = await getAdminAccountsList(ctx.db, cfg, { sort: "name", dir: "desc" });
    expect(descRows.map((r) => r.mainName)).toEqual(["Gamma", "Beta", "Alpha", null]);
  });

  it("filters by tier and by cryo status", async () => {
    const { a, b } = await seedTrio();
    const flygd = await getAdminAccountsList(ctx.db, cfg, { tier: "flygd" });
    expect(flygd.map((r) => r.accountId)).toEqual([a.id]);
    const cryo = await getAdminAccountsList(ctx.db, cfg, { status: "cryo" });
    expect(cryo.map((r) => r.accountId)).toEqual([b.id]);
  });

  it("sorts by tier rank and by tier-change date desc", async () => {
    await seedTrio();
    const byTier = await getAdminAccountsList(ctx.db, cfg, { sort: "tier" });
    expect(byTier.map((r) => r.tier)).toEqual(["flygd", "blue", "green"]);
    const byDate = await getAdminAccountsList(ctx.db, cfg, {
      sort: "tierChangedAt", dir: "desc",
    });
    // C is the only account with tierChangedAt; nulls sort last regardless of dir
    expect(byDate[0].tier).toBe("blue");
  });

  it("summarizes token health", async () => {
    const a = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, { id: 10, accountId: a.id, main: true, name: "T1" });
    await seedCharacter(ctx.db, cfg, { id: 11, accountId: a.id, name: "T2" });
    await ctx.db.update(character).set({ tokenStatus: "invalid" }).where(eq(character.id, 11));
    const [row] = await getAdminAccountsList(ctx.db, cfg);
    expect(row.tokenSummary).toEqual({ total: 2, healthy: 1, needsReauth: 0, dead: 1 });
  });
});
```

(`seedCharacter` already supports `name`; the file's existing `beforeEach` truncates the tables these tests touch, so no setup changes are needed — just extend the imports.)

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/account-view.test.ts`
Expected: FAIL (`getAdminAccountsList` not exported).

- [ ] **Step 3: Implement** — append to `src/services/account-view.ts` (the interfaces above, then):

```ts
const TIER_RANK = { flygd: 0, blue: 1, green: 2 } as const;

export async function getAdminAccountsList(
  dbx: Dbx,
  cfg: Config,
  filters: AdminListFilters = {},
): Promise<AdminAccountRow[]> {
  const [accounts, chars, links, syncStates, aclObs] = await Promise.all([
    dbx.select().from(account),
    dbx.select().from(character),
    dbx.select().from(discordLink),
    dbx.select().from(contactSyncState),
    dbx.select().from(wandererAclObservation),
  ]);
  const required = cfg.eveSso.scopes;
  const charsByAccount = new Map<string, typeof chars>();
  for (const c of chars) {
    const list = charsByAccount.get(c.accountId) ?? [];
    list.push(c);
    charsByAccount.set(c.accountId, list);
  }
  const linked = new Set(links.map((l) => l.accountId));
  const syncByChar = new Map(syncStates.map((s) => [s.characterId, s]));
  const obsByChar = new Map(aclObs.map((o) => [o.characterId, o]));
  const mainNameOf = new Map(
    accounts.map((a) => [
      a.id,
      chars.find((c) => c.id === a.mainCharacterId)?.name ?? null,
    ]),
  );

  let rows: AdminAccountRow[] = accounts.map((acc) => {
    const accChars = charsByAccount.get(acc.id) ?? [];
    const characters: AdminCharacterRow[] = accChars.map((c) => ({
      id: c.id,
      name: c.name,
      isMain: acc.mainCharacterId === c.id,
      tokenStatus: c.tokenStatus,
      needsReauthForScopes: required.some((s) => !c.scopes.includes(s)),
      affiliationInvalid: c.affiliationInvalid,
      contactSyncResult: syncByChar.get(c.id)?.lastResult ?? null,
      mapObservedAt: obsByChar.get(c.id)?.observedAt ?? null,
    }));
    const dead = characters.filter(
      (c) => c.tokenStatus === "invalid" || c.tokenStatus === "missing",
    ).length;
    const needsReauth = characters.filter(
      (c) =>
        c.tokenStatus !== "invalid" &&
        c.tokenStatus !== "missing" &&
        (c.tokenStatus === "needs_reauth" || c.needsReauthForScopes),
    ).length;
    return {
      accountId: acc.id,
      isAdmin: acc.isAdmin,
      tier: acc.tier,
      tierLocked: acc.tierLocked,
      tierChangedAt: acc.tierChangedAt,
      tierChangedByName:
        acc.tierChangedBy === null
          ? null
          : acc.tierChangedBy === "system"
            ? "system"
            : (mainNameOf.get(acc.tierChangedBy) ?? acc.tierChangedBy),
      status: acc.status,
      statusChangedAt: acc.statusChangedAt,
      statusNote: acc.statusNote,
      lastLoginAt: acc.lastLoginAt,
      mainName: mainNameOf.get(acc.id) ?? null,
      discordLinked: linked.has(acc.id),
      characters,
      tokenSummary: {
        total: characters.length,
        healthy: characters.length - dead - needsReauth,
        needsReauth,
        dead,
      },
      mapCount: characters.filter((c) => c.mapObservedAt !== null).length,
    };
  });

  if (filters.tier) rows = rows.filter((r) => r.tier === filters.tier);
  if (filters.status) rows = rows.filter((r) => r.status === filters.status);

  const dir = filters.dir === "desc" ? -1 : 1;
  const sort = filters.sort ?? "name";
  // Null placement ("no main", never-changed) is decided BEFORE direction is
  // applied: those rows sort last whether asc or desc.
  const nameCompare = (a: AdminAccountRow, b: AdminAccountRow): number => {
    const nulls = (a.mainName === null ? 1 : 0) - (b.mainName === null ? 1 : 0);
    if (nulls !== 0) return nulls;
    if (a.mainName === null || b.mainName === null) return 0;
    return a.mainName.toLowerCase().localeCompare(b.mainName.toLowerCase()) * dir;
  };
  rows.sort((a, b) => {
    if (sort === "name") return nameCompare(a, b);
    if (sort === "tierChangedAt") {
      const nulls =
        (a.tierChangedAt === null ? 1 : 0) - (b.tierChangedAt === null ? 1 : 0);
      if (nulls !== 0) return nulls;
      const cmp =
        a.tierChangedAt && b.tierChangedAt
          ? a.tierChangedAt.getTime() - b.tierChangedAt.getTime()
          : 0;
      return cmp * dir || nameCompare(a, b);
    }
    const cmp =
      sort === "tier"
        ? TIER_RANK[a.tier] - TIER_RANK[b.tier]
        : (a.status === "cryo" ? 1 : 0) - (b.status === "cryo" ? 1 : 0);
    return cmp * dir || nameCompare(a, b);
  });
  return rows;
}
```

Add `wandererAclObservation` to the file's schema import if missing (it's already imported for `getAccountView`).

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- tests/account-view.test.ts`
Expected: PASS (existing `getAccountView` cases included).

- [ ] **Step 5: Commit**

```bash
git add src/services/account-view.ts tests/account-view.test.ts
git commit -m "feat: admin accounts list read model with sort/filter"
```

---

### Task 4: Admin guard

**Files:**
- Create: `src/lib/admin-guard.ts`
- Test: `tests/admin-guard.test.ts`

**Interfaces:**
- Consumes: `getSessionAccount`, `account` table, `getConfig`/`getDb`, `cookies()` from `next/headers`.
- Produces:
  - `resolveAdmin(db: Db, sessionId: string | undefined): Promise<{ accountId: string } | null>` — the testable core: null when no/invalid session or `is_admin` false.
  - `getAdminContext(): Promise<{ accountId: string } | null>` — cookie wrapper for PAGES (page redirects on null).
  - `requireAdminAction(): Promise<{ accountId: string }>` — for SERVER ACTIONS; throws `Error("not authorized")` on null. Every admin action calls this first (layouts never protect actions).

- [ ] **Step 1: Write failing test** — `tests/admin-guard.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { account } from "@/db/schema";
import { resolveAdmin } from "@/lib/admin-guard";
import { createSession } from "@/services/session";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedAccount } from "./helpers/seed";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

describe("resolveAdmin", () => {
  it("resolves an admin session", async () => {
    const acc = await seedAccount(ctx.db);
    await ctx.db.update(account).set({ isAdmin: true }).where(eq(account.id, acc.id));
    const sid = await createSession(ctx.db, acc.id);
    expect(await resolveAdmin(ctx.db, sid)).toEqual({ accountId: acc.id });
  });

  it("rejects a signed-in non-admin", async () => {
    const acc = await seedAccount(ctx.db);
    const sid = await createSession(ctx.db, acc.id);
    expect(await resolveAdmin(ctx.db, sid)).toBeNull();
  });

  it("rejects missing and bogus sessions", async () => {
    expect(await resolveAdmin(ctx.db, undefined)).toBeNull();
    expect(await resolveAdmin(ctx.db, "not-a-session")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test -- tests/admin-guard.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — `src/lib/admin-guard.ts`:

```ts
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { getConfig } from "@/config";
import { getDb, type Db } from "@/db";
import { account } from "@/db/schema";
import { getSessionAccount } from "@/services/session";

export type AdminContext = { accountId: string };

/** Testable core: session id → admin account id, or null. */
export async function resolveAdmin(
  db: Db,
  sessionId: string | undefined,
): Promise<AdminContext | null> {
  if (!sessionId) return null;
  const sess = await getSessionAccount(db, sessionId);
  if (!sess) return null;
  const [acc] = await db.select().from(account).where(eq(account.id, sess.accountId));
  if (!acc?.isAdmin) return null;
  return { accountId: sess.accountId };
}

/** For admin PAGES: caller redirects on null. */
export async function getAdminContext(): Promise<AdminContext | null> {
  const cfg = getConfig();
  const sid = (await cookies()).get(cfg.sessionCookieName)?.value;
  return resolveAdmin(getDb(), sid);
}

/**
 * For admin SERVER ACTIONS: throws on failure. Layouts do not protect actions
 * and do not re-run on soft navigation — every action gates itself with this.
 */
export async function requireAdminAction(): Promise<AdminContext> {
  const ctx = await getAdminContext();
  if (!ctx) throw new Error("not authorized");
  return ctx;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- tests/admin-guard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/admin-guard.ts tests/admin-guard.test.ts
git commit -m "feat: admin session guard for pages and server actions"
```

---

### Task 5: Admin accounts page, actions, and admin nav

The core admin UI: one row per account with expandable alts, inline tier/lock controls, cryo toggle + date + notes, token health, Discord, Map (observed), last login, admin grant/revoke, per-account "sync now". Sort/filter via searchParams.

**Files:**
- Create: `src/app/admin/layout.tsx`, `src/app/admin/page.tsx`, `src/app/admin/accounts/page.tsx`, `src/app/admin/accounts/actions.ts`
- Modify: `src/app/account/page.tsx` (admin nav link)
- Test: typecheck + Playwright (Task 12); the services these call are already covered (Tasks 1–3).

**Interfaces:**
- Consumes: `getAdminContext`/`requireAdminAction` (Task 4), `getAdminAccountsList`/`AdminListSort` (Task 3), `setTierManual`/`returnTierToAuto`/`setAccountStatus`/`setStatusNote` (Task 2), `promoteAdmin`/`demoteAdmin` (Task 1), `enqueueSync`, `logAudit`.
- Produces: server actions `setTierAction(accountId, tier)`, `returnToAutoAction(accountId)`, `setStatusAction(accountId, status)`, `saveNoteAction(accountId, formData)`, `syncAccountAction(accountId)`, `promoteAdminAction(accountId)`, `demoteAdminAction(accountId)` — all `Promise<void>`, all revalidate `/admin/accounts`; `demoteAdminAction` redirects to `?error=last_admin` when blocked. Task 12's Playwright suite drives these.

- [ ] **Step 1: Implement the actions** — `src/app/admin/accounts/actions.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { requireAdminAction } from "@/lib/admin-guard";
import { demoteAdmin, promoteAdmin } from "@/services/accounts";
import {
  returnTierToAuto,
  setAccountStatus,
  setStatusNote,
  setTierManual,
} from "@/services/admin-accounts";
import { logAudit } from "@/services/audit";
import { enqueueSync } from "@/services/outbox";

export async function setTierAction(
  accountId: string,
  tier: "flygd" | "blue" | "green",
): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  const result = await getDb().transaction((tx) => setTierManual(tx, actor, accountId, tier));
  if (!result.ok) throw new Error(result.error);
  revalidatePath("/admin/accounts");
}

export async function returnToAutoAction(accountId: string): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  const result = await getDb().transaction((tx) => returnTierToAuto(tx, actor, accountId));
  if (!result.ok) throw new Error(result.error);
  revalidatePath("/admin/accounts");
}

export async function setStatusAction(
  accountId: string,
  status: "active" | "cryo",
): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  const result = await getDb().transaction((tx) =>
    setAccountStatus(tx, actor, accountId, status),
  );
  if (!result.ok) throw new Error(result.error);
  revalidatePath("/admin/accounts");
}

export async function saveNoteAction(accountId: string, formData: FormData): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  const note = String(formData.get("note") ?? "");
  const result = await getDb().transaction((tx) => setStatusNote(tx, actor, accountId, note));
  if (!result.ok) throw new Error(result.error);
  revalidatePath("/admin/accounts");
}

export async function syncAccountAction(accountId: string): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  await getDb().transaction(async (tx) => {
    await logAudit(tx, { actor, action: "sync.requested", target: accountId });
    await enqueueSync(tx, { kind: "account", accountId });
  });
  revalidatePath("/admin/accounts");
}

export async function promoteAdminAction(accountId: string): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  const result = await getDb().transaction((tx) => promoteAdmin(tx, actor, accountId));
  if (!result.ok) throw new Error(result.error);
  revalidatePath("/admin/accounts");
}

export async function demoteAdminAction(accountId: string): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  const result = await getDb().transaction((tx) => demoteAdmin(tx, actor, accountId));
  if (!result.ok && result.error === "last_admin") {
    // Surface the service's protection instead of a 500 (carry-over).
    redirect("/admin/accounts?error=last_admin");
  }
  if (!result.ok) throw new Error(result.error);
  revalidatePath("/admin/accounts");
}
```

- [ ] **Step 2: Implement layout + index redirect** — `src/app/admin/layout.tsx` (nav chrome ONLY — pages gate themselves):

```tsx
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ maxWidth: 1100, margin: "2rem auto", padding: "0 1rem" }}>
      <nav style={{ display: "flex", gap: "1rem", marginBottom: "1rem" }}>
        <strong>authGD admin</strong>
        <a href="/admin/accounts">Accounts</a>
        <a href="/admin/audit">Audit log</a>
        <a href="/admin/sync">Sync</a>
        <a href="/account">Your account</a>
      </nav>
      {children}
    </div>
  );
}
```

`src/app/admin/page.tsx`:

```tsx
import { redirect } from "next/navigation";

export default function AdminIndex() {
  redirect("/admin/accounts");
}
```

- [ ] **Step 3: Implement the accounts page** — `src/app/admin/accounts/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { getAdminContext } from "@/lib/admin-guard";
import {
  getAdminAccountsList,
  type AdminAccountRow,
  type AdminListSort,
} from "@/services/account-view";
import {
  demoteAdminAction,
  promoteAdminAction,
  returnToAutoAction,
  saveNoteAction,
  setStatusAction,
  setTierAction,
  syncAccountAction,
} from "./actions";

export const dynamic = "force-dynamic";

const SORTS: Array<{ key: AdminListSort; label: string }> = [
  { key: "name", label: "Name" },
  { key: "tier", label: "Tier" },
  { key: "status", label: "Cryo" },
  { key: "tierChangedAt", label: "Tier changed" },
];
const TIERS = ["flygd", "blue", "green"] as const;

function fmt(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : "—";
}

export default async function AdminAccountsPage({
  searchParams,
}: {
  searchParams: Promise<{
    tier?: string; status?: string; sort?: string; dir?: string; error?: string;
  }>;
}) {
  const ctx = await getAdminContext();
  if (!ctx) redirect("/login");
  const params = await searchParams;
  const sort = (SORTS.some((s) => s.key === params.sort) ? params.sort : "name") as AdminListSort;
  const dir = params.dir === "desc" ? "desc" : "asc";
  const tier = TIERS.includes(params.tier as (typeof TIERS)[number])
    ? (params.tier as (typeof TIERS)[number])
    : undefined;
  const status =
    params.status === "cryo" || params.status === "active" ? params.status : undefined;
  const rows = await getAdminAccountsList(getDb(), getConfig(), { tier, status, sort, dir });

  const qs = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ tier, status, sort, dir, ...over })) {
      if (v) p.set(k, v);
    }
    return `/admin/accounts?${p.toString()}`;
  };

  return (
    <main>
      <h1>Accounts</h1>
      {params.error === "last_admin" && (
        <p role="alert">Cannot demote the last admin.</p>
      )}
      <p>
        Filter tier: <a href={qs({ tier: undefined })}>all</a>{" "}
        {TIERS.map((t) => (
          <a key={t} href={qs({ tier: t })} style={{ marginRight: 8 }}>
            {tier === t ? <strong>{t}</strong> : t}
          </a>
        ))}
        · Status: <a href={qs({ status: undefined })}>all</a>{" "}
        <a href={qs({ status: "cryo" })}>{status === "cryo" ? <strong>cryo</strong> : "cryo"}</a>{" "}
        <a href={qs({ status: "active" })}>
          {status === "active" ? <strong>active</strong> : "active"}
        </a>
      </p>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            {SORTS.map((s) => (
              <th key={s.key} style={{ textAlign: "left" }}>
                <a href={qs({ sort: s.key, dir: sort === s.key && dir === "asc" ? "desc" : "asc" })}>
                  {s.label}
                  {sort === s.key ? (dir === "asc" ? " ↑" : " ↓") : ""}
                </a>
              </th>
            ))}
            <th>Tokens</th>
            <th>Discord</th>
            <th>Map</th>
            <th>Last login</th>
            <th>Admin</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <AccountRow key={r.accountId} r={r} />
          ))}
        </tbody>
      </table>
    </main>
  );
}

function AccountRow({ r }: { r: AdminAccountRow }) {
  return (
    <tr style={{ borderTop: "1px solid #ccc", verticalAlign: "top" }}>
      <td>
        <details>
          <summary>
            {r.mainName ?? <em>no main</em>}
            {r.characters.length > 1 && ` (+${r.characters.length - 1})`}
          </summary>
          <ul style={{ margin: "0.25rem 0" }}>
            {r.characters.map((c) => (
              <li key={c.id}>
                {c.name}
                {c.isMain && " (main)"} — token: {c.tokenStatus}
                {c.needsReauthForScopes && " (scope shortfall)"}
                {c.affiliationInvalid && " · affiliation invalid"}
                {c.contactSyncResult && ` · contacts: ${c.contactSyncResult}`}
                {c.mapObservedAt &&
                  ` · on map (observed ${c.mapObservedAt.toISOString().slice(0, 16)}Z)`}
              </li>
            ))}
          </ul>
          <form action={saveNoteAction.bind(null, r.accountId)}>
            <input name="note" defaultValue={r.statusNote ?? ""} placeholder="notes" />
            <button type="submit">save note</button>
          </form>
        </details>
      </td>
      <td>
        {r.tier}
        {r.tierLocked && " 🔒"}
        <div style={{ fontSize: "0.8em", opacity: 0.8 }}>
          {fmt(r.tierChangedAt)}
          {r.tierChangedByName && ` by ${r.tierChangedByName}`}
        </div>
        <div>
          {(["flygd", "blue", "green"] as const).map((t) => (
            <form key={t} action={setTierAction.bind(null, r.accountId, t)} style={{ display: "inline" }}>
              <button type="submit" disabled={r.tierLocked && r.tier === t}>
                {t}
              </button>
            </form>
          ))}
          {r.tierLocked && (
            <form action={returnToAutoAction.bind(null, r.accountId)} style={{ display: "inline" }}>
              <button type="submit">auto</button>
            </form>
          )}
        </div>
      </td>
      <td>
        {r.status}
        {r.status === "cryo" && (
          <div style={{ fontSize: "0.8em", opacity: 0.8 }}>since {fmt(r.statusChangedAt)}</div>
        )}
        {r.statusNote && <div style={{ fontSize: "0.8em" }}>{r.statusNote}</div>}
        <form
          action={setStatusAction.bind(null, r.accountId, r.status === "cryo" ? "active" : "cryo")}
        >
          <button type="submit">{r.status === "cryo" ? "wake" : "cryo"}</button>
        </form>
      </td>
      <td>{fmt(r.tierChangedAt)}</td>
      <td>
        {r.tokenSummary.healthy}/{r.tokenSummary.total} ok
        {r.tokenSummary.needsReauth > 0 && ` · ${r.tokenSummary.needsReauth} re-auth`}
        {r.tokenSummary.dead > 0 && ` · ${r.tokenSummary.dead} dead`}
      </td>
      <td>{r.discordLinked ? "✓" : "✗"}</td>
      <td>{r.mapCount > 0 ? `${r.mapCount}/${r.tokenSummary.total}` : "✗"}</td>
      <td>{fmt(r.lastLoginAt)}</td>
      <td>
        {r.isAdmin ? (
          <form action={demoteAdminAction.bind(null, r.accountId)}>
            <button type="submit">revoke ✓</button>
          </form>
        ) : (
          <form action={promoteAdminAction.bind(null, r.accountId)}>
            <button type="submit">grant</button>
          </form>
        )}
      </td>
      <td>
        <form action={syncAccountAction.bind(null, r.accountId)}>
          <button type="submit">sync now</button>
        </form>
      </td>
    </tr>
  );
}
```

- [ ] **Step 4: Admin link on the member page** — in `src/app/account/page.tsx`, after the `<h1>Your account</h1>` line add:

```tsx
      {view.isAdmin && (
        <p>
          <a href="/admin/accounts">Admin →</a>
        </p>
      )}
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm run build`
Expected: both succeed (build proves the pages compile as server components with bound actions).
Run: `npm test`
Expected: all suites still PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/admin src/app/account/page.tsx
git commit -m "feat: admin accounts page with tier/cryo/admin controls and sync-now"
```

---

### Task 6: Audit log query + page

**Files:**
- Modify: `src/services/audit.ts` (add `queryAuditLog`)
- Create: `src/app/admin/audit/page.tsx`
- Test: `tests/audit-query.test.ts`

**Interfaces:**
- Consumes: `auditLog` table; `getAdminContext`.
- Produces: `queryAuditLog(dbx: Dbx, filters?: { actor?: string; action?: string; target?: string; beforeId?: number; limit?: number }): Promise<Array<typeof auditLog.$inferSelect>>` — newest first; `action` is a PREFIX match (`tier.` matches `tier.changed` and `tier.unlocked`); `actor`/`target` exact; `beforeId` is the pagination cursor; default/max limit 100.

- [ ] **Step 1: Write failing test** — `tests/audit-query.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { logAudit, queryAuditLog } from "@/services/audit";
import { setupTestDb, truncateAll } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

describe("queryAuditLog", () => {
  beforeEach(async () => {
    await logAudit(ctx.db, { actor: "system", action: "tier.changed", target: "acc-1" });
    await logAudit(ctx.db, { actor: "admin-1", action: "tier.unlocked", target: "acc-1" });
    await logAudit(ctx.db, { actor: "admin-1", action: "character.linked", target: "42" });
  });

  it("returns newest first, unfiltered", async () => {
    const rows = await queryAuditLog(ctx.db);
    expect(rows.map((r) => r.action)).toEqual([
      "character.linked",
      "tier.unlocked",
      "tier.changed",
    ]);
  });

  it("filters by action prefix, actor, and target", async () => {
    expect((await queryAuditLog(ctx.db, { action: "tier." })).map((r) => r.action)).toEqual([
      "tier.unlocked",
      "tier.changed",
    ]);
    expect(await queryAuditLog(ctx.db, { actor: "admin-1" })).toHaveLength(2);
    expect(await queryAuditLog(ctx.db, { target: "42" })).toHaveLength(1);
  });

  it("treats LIKE wildcards in the action filter as literals", async () => {
    expect(await queryAuditLog(ctx.db, { action: "tier%" })).toHaveLength(0);
    expect(await queryAuditLog(ctx.db, { action: "t_er." })).toHaveLength(0);
  });

  it("paginates with beforeId and caps the limit", async () => {
    const all = await queryAuditLog(ctx.db);
    const older = await queryAuditLog(ctx.db, { beforeId: all[0].id });
    expect(older.map((r) => r.id)).toEqual(all.slice(1).map((r) => r.id));
    expect(await queryAuditLog(ctx.db, { limit: 1 })).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test -- tests/audit-query.test.ts`
Expected: FAIL (`queryAuditLog` not exported).

- [ ] **Step 3: Implement** — append to `src/services/audit.ts` (extend its imports with `and, desc, eq, like, lt` from drizzle-orm):

```ts
export async function queryAuditLog(
  dbx: Dbx,
  filters: {
    actor?: string;
    action?: string; // prefix match, e.g. "tier."
    target?: string;
    beforeId?: number;
    limit?: number;
  } = {},
): Promise<Array<typeof auditLog.$inferSelect>> {
  const conds = [];
  if (filters.actor) conds.push(eq(auditLog.actor, filters.actor));
  if (filters.action) {
    // The filter is a LITERAL prefix; % and _ are LIKE wildcards, so escape
    // them (and backslash, Postgres's default escape character).
    const prefix = filters.action.replace(/[\\%_]/g, (c) => `\\${c}`);
    conds.push(like(auditLog.action, `${prefix}%`));
  }
  if (filters.target) conds.push(eq(auditLog.target, filters.target));
  if (filters.beforeId !== undefined) conds.push(lt(auditLog.id, filters.beforeId));
  const limit = Math.min(filters.limit ?? 100, 100);
  return dbx
    .select()
    .from(auditLog)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(auditLog.id))
    .limit(limit);
}
```

- [ ] **Step 4: Implement the page** — `src/app/admin/audit/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { getAdminContext } from "@/lib/admin-guard";
import { queryAuditLog } from "@/services/audit";

export const dynamic = "force-dynamic";

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ actor?: string; action?: string; target?: string; before?: string }>;
}) {
  const ctx = await getAdminContext();
  if (!ctx) redirect("/login");
  const params = await searchParams;
  const beforeId = params.before ? Number(params.before) : undefined;
  const rows = await queryAuditLog(getDb(), {
    actor: params.actor || undefined,
    action: params.action || undefined,
    target: params.target || undefined,
    beforeId: Number.isFinite(beforeId) ? beforeId : undefined,
  });
  const older = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v && k !== "before") older.set(k, v);
  if (rows.length > 0) older.set("before", String(rows[rows.length - 1].id));

  return (
    <main>
      <h1>Audit log</h1>
      <form method="get" style={{ marginBottom: "1rem" }}>
        <input name="actor" placeholder="actor" defaultValue={params.actor ?? ""} />{" "}
        <input name="action" placeholder="action prefix (tier.)" defaultValue={params.action ?? ""} />{" "}
        <input name="target" placeholder="target" defaultValue={params.target ?? ""} />{" "}
        <button type="submit">Filter</button> <a href="/admin/audit">clear</a>
      </form>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>At</th>
            <th style={{ textAlign: "left" }}>Actor</th>
            <th style={{ textAlign: "left" }}>Action</th>
            <th style={{ textAlign: "left" }}>Target</th>
            <th style={{ textAlign: "left" }}>Details</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} style={{ borderTop: "1px solid #ccc" }}>
              <td>{r.at.toISOString().replace("T", " ").slice(0, 19)}</td>
              <td>{r.actor}</td>
              <td>{r.action}</td>
              <td>{r.target}</td>
              <td>
                <code>{r.details ? JSON.stringify(r.details) : ""}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 100 && <p><a href={`/admin/audit?${older.toString()}`}>Older →</a></p>}
    </main>
  );
}
```

- [ ] **Step 5: Verify and commit**

Run: `npm test -- tests/audit-query.test.ts && npm run typecheck`
Expected: PASS.

```bash
git add src/services/audit.ts src/app/admin/audit tests/audit-query.test.ts
git commit -m "feat: filterable admin audit log page"
```

---

### Task 7: Sync status page, F7 recheck labeling, global sync-now, recheck button

Three tightly coupled pieces: (a) F7 — recheck runs must record `sync_run.job_type = "membership-recheck"` so the page can label them; (b) the grouped `sync_run` read model + page; (c) "sync now" (global) and "recheck invalid affiliations" buttons — both outbox-only, which needs a new `{kind:"membership-recheck"}` payload through `planDispatch`.

**Files:**
- Modify: `src/jobs/membership.ts` (F7), `src/db/schema.ts` (outbox payload union type — TS-only, no migration), `src/worker/dispatcher.ts` (`planDispatch` case)
- Create: `src/services/sync-status.ts`, `src/app/admin/sync/page.tsx`, `src/app/admin/sync/actions.ts`
- Test: `tests/sync-status.test.ts`; update `tests/membership-job.test.ts` + `tests/dispatcher.test.ts`

**Interfaces:**
- Consumes: `syncRun` table, `enqueueSync`, `logAudit`, `getAdminContext`/`requireAdminAction`, `QUEUES` (dispatcher).
- Produces:
  - `runMembershipJob` unchanged signature; records `sync_run.job_type` `"membership-recheck"` when `opts.recheckInvalid` is true, `"membership"` otherwise.
  - `OutboxPayload` union gains `{ kind: "membership-recheck" }`; `planDispatch` maps it to ONE send: queue `membership-recheck`, data `{ jobType: "membership-recheck" }`, singletonKey `"membership-recheck:all"`.
  - `getSyncStatus(dbx: Dbx, runsPerJob?: number): Promise<Array<{ jobType: string; runs: Array<typeof syncRun.$inferSelect> }>>` in `src/services/sync-status.ts` — known job types first in fixed order (`membership`, `membership-recheck`, `contacts`, `wanderer`, `discord-roles`, `token-health`, `purge`), then unknown types alphabetically; newest runs first; default 5 per job. **One query per job type** (distinct types + a limited query each) — a global row window would routinely drop the weekly recheck behind ~122 hourly/half-hourly runs per day.
  - Actions `syncAllAction(): Promise<void>` (audit `sync.requested` target `"all"` + `enqueueSync({kind:"all"})`, one tx) and `recheckInvalidAction(): Promise<void>` (audit `sync.recheck_requested` target `"all"` + `enqueueSync({kind:"membership-recheck"})`).

- [ ] **Step 1: Write failing tests**

`tests/sync-status.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getSyncStatus } from "@/services/sync-status";
import { finishSyncRun, startSyncRun } from "@/services/sync-run";
import { setupTestDb, truncateAll } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

describe("getSyncStatus", () => {
  it("groups newest-first per job with known jobs in fixed order", async () => {
    for (let i = 0; i < 3; i++) {
      const id = await startSyncRun(ctx.db, "contacts");
      await finishSyncRun(ctx.db, id, { status: "ok", counts: { added: i } });
    }
    const id = await startSyncRun(ctx.db, "membership");
    await finishSyncRun(ctx.db, id, { status: "failed", errorSummary: "boom" });
    const groups = await getSyncStatus(ctx.db, 2);
    expect(groups.map((g) => g.jobType)).toEqual(["membership", "contacts"]);
    expect(groups[1].runs).toHaveLength(2); // capped at runsPerJob
    expect(groups[1].runs[0].counts).toEqual({ added: 2 }); // newest first
    expect(groups[0].runs[0].errorSummary).toBe("boom");
  });

  it("lists unknown job types after known ones", async () => {
    await startSyncRun(ctx.db, "zz-custom");
    await startSyncRun(ctx.db, "purge");
    const groups = await getSyncStatus(ctx.db);
    expect(groups.map((g) => g.jobType)).toEqual(["purge", "zz-custom"]);
  });

  it("keeps rare jobs visible no matter how many runs other jobs pile up", async () => {
    await startSyncRun(ctx.db, "membership-recheck");
    for (let i = 0; i < 20; i++) await startSyncRun(ctx.db, "contacts");
    const groups = await getSyncStatus(ctx.db, 5);
    expect(groups.map((g) => g.jobType)).toEqual(["membership-recheck", "contacts"]);
    expect(groups[1].runs).toHaveLength(5);
  });
});
```

Append to `tests/membership-job.test.ts` (inside the existing describe; `syncRun` + `desc` imports needed):

```ts
  it("labels recheck runs membership-recheck in sync_run (F7)", async () => {
    await runMembershipJob({ db: ctx.db, cfg, esi: esiWith({}) }, { recheckInvalid: true });
    await runMembershipJob({ db: ctx.db, cfg, esi: esiWith({}) });
    const runs = await ctx.db.select().from(syncRun).orderBy(desc(syncRun.id));
    expect(runs.map((r) => r.jobType)).toEqual(["membership", "membership-recheck"]);
  });
```

Append to `tests/dispatcher.test.ts` (planDispatch describe):

```ts
  it("maps membership-recheck to the recheck queue with its global singleton key", () => {
    const plan = planDispatch({ kind: "membership-recheck" });
    expect(plan).toEqual([
      {
        queue: "membership-recheck",
        data: { jobType: "membership-recheck" },
        singletonKey: "membership-recheck:all",
      },
    ]);
  });
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/sync-status.test.ts tests/membership-job.test.ts tests/dispatcher.test.ts`
Expected: FAIL — module missing, recheck run recorded as `"membership"`, planDispatch type error/missing case.

- [ ] **Step 3: Implement**

`src/jobs/membership.ts` — replace the `runJob(db, "membership", …)` opening with:

```ts
  // F7: recheck runs get their own sync_run label so the admin sync page can
  // distinguish the weekly/on-demand invalid-affiliation recheck from the anchor.
  const jobType = opts.recheckInvalid ? "membership-recheck" : "membership";
  return runJob(db, jobType, async () => {
```

`src/db/schema.ts` — extend the outbox payload union:

```ts
      .$type<
        | { kind: "account"; accountId: string }
        | { kind: "discord-user"; discordUserId: string }
        | { kind: "membership-recheck" }
        | { kind: "all" }
      >()
```

`src/worker/dispatcher.ts` — `planDispatch` is an exhaustive `switch (payload.kind)`; add this case (the compiler forces it once the schema union grows). Data carries `jobType` for dead-letter naming like every existing entry:

```ts
    case "membership-recheck":
      return [
        {
          queue: QUEUES.membershipRecheck,
          data: { jobType: QUEUES.membershipRecheck },
          singletonKey: "membership-recheck:all",
        },
      ];
```

`src/services/sync-status.ts`:

```ts
import { desc, eq } from "drizzle-orm";
import type { Dbx } from "@/db";
import { syncRun } from "@/db/schema";

const KNOWN_ORDER = [
  "membership",
  "membership-recheck",
  "contacts",
  "wanderer",
  "discord-roles",
  "token-health",
  "purge",
];

export async function getSyncStatus(
  dbx: Dbx,
  runsPerJob = 5,
): Promise<Array<{ jobType: string; runs: Array<typeof syncRun.$inferSelect> }>> {
  // One limited query per job type (~8 total): a single global row window
  // would drop rare jobs (weekly membership-recheck) behind the ~122
  // hourly/half-hourly runs recorded per day.
  const types = await dbx.selectDistinct({ jobType: syncRun.jobType }).from(syncRun);
  const present = types.map((t) => t.jobType);
  const known = KNOWN_ORDER.filter((j) => present.includes(j));
  const unknown = present.filter((j) => !KNOWN_ORDER.includes(j)).sort();
  return Promise.all(
    [...known, ...unknown].map(async (jobType) => ({
      jobType,
      runs: await dbx
        .select()
        .from(syncRun)
        .where(eq(syncRun.jobType, jobType))
        .orderBy(desc(syncRun.id))
        .limit(runsPerJob),
    })),
  );
}
```

`src/app/admin/sync/actions.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { requireAdminAction } from "@/lib/admin-guard";
import { logAudit } from "@/services/audit";
import { enqueueSync } from "@/services/outbox";

export async function syncAllAction(): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  await getDb().transaction(async (tx) => {
    await logAudit(tx, { actor, action: "sync.requested", target: "all" });
    await enqueueSync(tx, { kind: "all" });
  });
  revalidatePath("/admin/sync");
}

export async function recheckInvalidAction(): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  await getDb().transaction(async (tx) => {
    await logAudit(tx, { actor, action: "sync.recheck_requested", target: "all" });
    await enqueueSync(tx, { kind: "membership-recheck" });
  });
  revalidatePath("/admin/sync");
}
```

`src/app/admin/sync/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { getAdminContext } from "@/lib/admin-guard";
import { getSyncStatus } from "@/services/sync-status";
import { recheckInvalidAction, syncAllAction } from "./actions";

export const dynamic = "force-dynamic";

function fmt(d: Date | null): string {
  return d ? d.toISOString().replace("T", " ").slice(0, 19) : "…";
}

export default async function AdminSyncPage() {
  const ctx = await getAdminContext();
  if (!ctx) redirect("/login");
  const groups = await getSyncStatus(getDb());

  return (
    <main>
      <h1>Sync</h1>
      <div style={{ margin: "1rem 0", display: "flex", gap: "0.5rem" }}>
        <form action={syncAllAction}>
          <button type="submit">Sync everything now</button>
        </form>
        <form action={recheckInvalidAction}>
          <button type="submit">Recheck invalid affiliations</button>
        </form>
      </div>
      {groups.length === 0 && <p>No runs recorded yet.</p>}
      {groups.map((g) => (
        <section key={g.jobType}>
          <h2>{g.jobType}</h2>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Started</th>
                <th style={{ textAlign: "left" }}>Finished</th>
                <th style={{ textAlign: "left" }}>Status</th>
                <th style={{ textAlign: "left" }}>Counts</th>
                <th style={{ textAlign: "left" }}>Error</th>
              </tr>
            </thead>
            <tbody>
              {g.runs.map((r) => (
                <tr key={r.id} style={{ borderTop: "1px solid #ccc" }}>
                  <td>{fmt(r.startedAt)}</td>
                  <td>{fmt(r.finishedAt)}</td>
                  <td>
                    {r.status === "failed" ? <strong>failed</strong> : (r.status ?? "running")}
                  </td>
                  <td>
                    <code>{r.counts ? JSON.stringify(r.counts) : ""}</code>
                  </td>
                  <td>{r.errorSummary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </main>
  );
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- tests/sync-status.test.ts tests/membership-job.test.ts tests/dispatcher.test.ts tests/outbox.test.ts tests/worker-queues.test.ts && npm run typecheck`
Expected: PASS. (If `planDispatch` uses an exhaustive switch, the compiler enforced the new case — good.)

- [ ] **Step 5: Commit**

```bash
git add src/jobs/membership.ts src/db/schema.ts src/worker/dispatcher.ts src/services/sync-status.ts src/app/admin/sync tests/sync-status.test.ts tests/membership-job.test.ts tests/dispatcher.test.ts
git commit -m "feat: admin sync page, sync-now/recheck buttons, distinct recheck run label"
```

---

### Task 8: F5 — CAS the contacts `needs_reauth` write; F6 — ESI User-Agent

**Files:**
- Modify: `src/jobs/contacts.ts`, `src/lib/esi/client.ts`, `src/config.ts`, `src/worker/index.ts`, `tests/helpers/config.ts`
- Test: `tests/contacts-job.test.ts` (append), `tests/esi-client.test.ts` (append), `tests/config.test.ts` (append if it asserts full config shape)

**Interfaces:**
- Consumes: existing `getFreshAccessToken` result (`token.tokenEnc` is the blob its CAS just stored).
- Produces:
  - Contacts job: the `needs_reauth` status write becomes conditional on `refresh_token_enc = token.tokenEnc` — a guard miss (row rotated/reclaimed since our refresh) changes nothing, matching every other status write (carry-over F5).
  - `createEsiClient` accepts `userAgent?: string`; when set, every ESI request carries it as the `User-Agent` header (CCP requirement).
  - Config: new REQUIRED env `ESI_CONTACT` (operator contact — email or EVE character name) exposed as `cfg.esiContact`; the worker builds `authgd/0.1.0 (<contact>)`.

- [ ] **Step 1: Write failing tests**

Append to `tests/contacts-job.test.ts` (reuse its `okToken`, `fakeEsi`, seeds):

```ts
describe("needs_reauth CAS (F5)", () => {
  it("marks needs_reauth when the token blob is unchanged", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
    const esi: ContactsEsi = {
      ...fakeEsi({ labels: { 1: [{ labelId: 7, labelName: "flygd" }] } }).esi,
      getAllContacts: async () => {
        throw new EsiError("missing scope", 403, "needs_reauth");
      },
    };
    await runContactsJob({ db: ctx.db, cfg, esi, fetchImpl: okToken });
    const [ch] = await ctx.db.select().from(character).where(eq(character.id, 1));
    expect(ch.tokenStatus).toBe("needs_reauth");
  });

  it("does NOT downgrade a row whose token rotated underneath the job", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
    const esi: ContactsEsi = {
      ...fakeEsi({ labels: { 1: [{ labelId: 7, labelName: "flygd" }] } }).esi,
      getAllContacts: async () => {
        // concurrent re-auth: someone else stored a fresh blob mid-flight
        await ctx.db
          .update(character)
          .set({ refreshTokenEnc: "someone-elses-blob", tokenStatus: "valid" })
          .where(eq(character.id, 1));
        throw new EsiError("missing scope", 403, "needs_reauth");
      },
    };
    await runContactsJob({ db: ctx.db, cfg, esi, fetchImpl: okToken });
    const [ch] = await ctx.db.select().from(character).where(eq(character.id, 1));
    expect(ch.tokenStatus).toBe("valid"); // stale decision discarded
  });
});
```

Append to `tests/esi-client.test.ts`:

```ts
describe("User-Agent (F6)", () => {
  it("sends the configured User-Agent on every request", async () => {
    let ua: string | null = null;
    server.use(
      http.post(`${BASE}/characters/affiliation/`, ({ request }) => {
        ua = request.headers.get("user-agent");
        return HttpResponse.json([]);
      }),
    );
    const esi = createEsiClient({ userAgent: "authgd/0.1.0 (ops@example.com)" });
    await esi.postAffiliation([1]);
    expect(ua).toBe("authgd/0.1.0 (ops@example.com)");
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/contacts-job.test.ts tests/esi-client.test.ts`
Expected: the CAS-miss case FAILS (status downgraded today) and the UA case FAILS (option doesn't exist).

- [ ] **Step 3: Implement**

`src/jobs/contacts.ts` — add `and` to the drizzle-orm import; replace the unconditional needs_reauth write with:

```ts
        if (needsReauth) {
          counts.failed++;
          // CAS on the blob our refresh just stored (F5): if the row rotated
          // or was reclaimed since, this stale decision must not touch it.
          await db
            .update(character)
            .set({ tokenStatus: "needs_reauth" })
            .where(
              and(
                eq(character.id, target.characterId),
                eq(character.refreshTokenEnc, token.tokenEnc),
              ),
            );
          await recordResult(db, target.characterId, "needs_reauth", false);
        } else {
```

`src/lib/esi/client.ts` — add to `EsiClientOptions`:

```ts
  /** CCP asks every ESI consumer to identify itself with contact info. */
  userAgent?: string;
```

and in `request()` where headers are assembled:

```ts
    if (opts.userAgent) headers["user-agent"] = opts.userAgent;
```

`src/config.ts` — add to the env schema (near STANDINGS_*):

```ts
  // CCP requires ESI consumers to send identifying contact info (F6).
  ESI_CONTACT: z.string().min(1),
```

and to the returned object: `esiContact: e.ESI_CONTACT,`

`src/worker/index.ts` — pass it where the client is created:

```ts
    esi: createEsiClient({ userAgent: `authgd/0.1.0 (${cfg.esiContact})` }),
```

`ESI_CONTACT` is REQUIRED, so EVERY place tests build config env needs it. Add `ESI_CONTACT: "ops@example.com",` to each of: `tests/helpers/config.ts` (the shared env block), the inline `loadConfig({...})` blocks in `tests/account-view.test.ts`, `tests/eve-sso.test.ts` (~line 12), `tests/accounts.test.ts` (~line 32), and `tests/discord-link.test.ts` (~line 7), the `process.env.X = ...` block at the top of `tests/auth-routes.test.ts`, and `tests/config.test.ts` if it builds env by hand. Then run `grep -rln "loadConfig\|EVE_SSO_CLIENT_ID" tests` and confirm every hit is covered — the full suite fails otherwise.

- [ ] **Step 4: Run the full suite** (the new required env touches every config consumer)

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/jobs/contacts.ts src/lib/esi/client.ts src/config.ts src/worker/index.ts tests/helpers/config.ts tests/contacts-job.test.ts tests/esi-client.test.ts tests/config.test.ts tests/account-view.test.ts tests/auth-routes.test.ts tests/eve-sso.test.ts tests/accounts.test.ts tests/discord-link.test.ts
git commit -m "fix: CAS-guard contacts needs_reauth write; ESI User-Agent from config"
```

---

### Task 9: Retire `testJwksOverride` (dependency injection)

The mutable `testJwksOverride` export in `src/lib/esi/sso.ts` sits on the token-health ownership-transfer path — production code consults test state. `verifyEveAccessToken` already takes an optional `getKey`; make that the ONLY injection point.

**Files:**
- Modify: `src/lib/esi/sso.ts`, `src/jobs/token-health.ts`, `tests/token-health-job.test.ts`, `tests/auth-routes.test.ts`
- Test: existing suites (this is a refactor — behavior identical, injection route changes)

**Interfaces:**
- Consumes: `JWTVerifyGetKey` from jose.
- Produces:
  - `src/lib/esi/sso.ts`: DELETE `testJwksOverride` and `setTestJwksOverride`; the verify line becomes `jwtVerify(accessToken, getKey ?? remoteJwks, …)`.
  - `runTokenHealthJob` deps gain `jwks?: JWTVerifyGetKey`, threaded into every `verifyEveAccessToken(token.accessToken, deps.jwks)` call inside the job. Production (worker handlers) passes nothing → remote JWKS.

- [ ] **Step 1: Make the production change**

In `src/lib/esi/sso.ts`: remove the two exports at the bottom and change line ~117 to `getKey ?? remoteJwks`.
In `src/jobs/token-health.ts`: add `import type { JWTVerifyGetKey } from "jose";`, add `jwks?: JWTVerifyGetKey;` to the deps type, and pass `deps.jwks` as the second argument to every `verifyEveAccessToken` call in the file.

- [ ] **Step 2: Run tests to see exactly the expected failures**

Run: `npm test -- tests/token-health-job.test.ts tests/auth-routes.test.ts tests/eve-sso.test.ts`
Expected: token-health + auth-routes FAIL to compile (importing the deleted `setTestJwksOverride`); eve-sso PASSES (it already injects via the parameter).

- [ ] **Step 3: Migrate the tests**

`tests/token-health-job.test.ts`: drop the `setTestJwksOverride` import and both `setTestJwksOverride(...)` calls; keep the generated keypair; build the getKey once —

```ts
let jwks: ReturnType<typeof createLocalJWKSet>;
// in beforeAll, after generateKeyPair:
jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), alg: "RS256" }] });
```

— and add `jwks` to every `runTokenHealthJob({ db: …, cfg, … })` deps object in the file (mechanical: the deps literal appears in each test case).

`tests/auth-routes.test.ts`: the route handler calls `verifyEveAccessToken` with no injection, so serve the JWKS over HTTP instead — the file already runs msw. Drop the `setTestJwksOverride` import/calls, declare `let jwk: Record<string, unknown>;` at module scope, assign it in `beforeAll` (`jwk = { ...(await exportJWK(publicKey)), alg: "RS256" };`), and register the handler as one of the server's INITIAL handlers (so `resetHandlers()` keeps it):

```ts
const msw = setupServer(
  http.get("https://login.eveonline.com/oauth/jwks", () => HttpResponse.json({ keys: [jwk] })),
  // …any existing initial handlers stay…
);
```

(jose v6's `createRemoteJWKSet` uses global fetch, which msw intercepts; the module-level JWKS cache is per test file because vitest isolates modules, and each file uses a single keypair.)

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test && npm run typecheck`
Expected: PASS — and `grep -rn "testJwksOverride" src tests` returns nothing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/esi/sso.ts src/jobs/token-health.ts tests/token-health-job.test.ts tests/auth-routes.test.ts
git commit -m "refactor: retire testJwksOverride in favor of injected JWKS"
```

---

### Task 10: Dockerfile + fly.toml (one image, web + worker)

One image runs three commands: `node web/server.js` (web, standalone Next build), `npx tsx src/worker/index.ts` (worker), `npm run db:migrate` (Fly release command). The worker and migrator run from source via tsx, so tsx must be a production dependency.

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `fly.toml`
- Modify: `package.json` (move `tsx` from devDependencies to dependencies)
- Test: `docker build` + container smoke commands (no vitest — this is infra)

**Interfaces:**
- Consumes: `next.config.ts` already sets `output: "standalone"`; `npm run worker` / `npm run db:migrate` already exist.
- Produces: image layout `/app/web/server.js` (standalone server + its pruned node_modules + static assets), `/app/src` + `/app/drizzle` + full prod node_modules (worker, migrate). Task 11's docs reference these commands; fly.toml's process names `web`/`worker` are load-bearing for `fly scale`.

- [ ] **Step 1: Move tsx to dependencies**

In `package.json`, move `"tsx": "^4.19.0"` from devDependencies to dependencies, then run `npm install` (updates the lockfile).

- [ ] **Step 2: Write `.dockerignore`**

```
node_modules
.next
.git
.claude
docs
tests
e2e
tmp
docker-compose.dev.yml
*.md
```

- [ ] **Step 3: Write the Dockerfile**

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
# Config env vars are validated lazily at request/startup time, never at build.
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# Web process: the self-contained standalone server.
COPY --from=build /app/.next/standalone ./web
COPY --from=build /app/.next/static ./web/.next/static
# Worker + release migrate run from source via tsx (prod dependency).
COPY src ./src
COPY drizzle ./drizzle
COPY tsconfig.json next.config.ts ./
ENV HOSTNAME=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["node", "web/server.js"]
```

(No `public/` directory exists in this repo; if one is added later it must be copied into `web/public`.)

- [ ] **Step 4: Write fly.toml**

```toml
# authGD — one image, two process groups + release-time migrations.
app = "authgd"
primary_region = "iad"

[build]

[deploy]
  release_command = "npm run db:migrate"

[processes]
  web = "node web/server.js"
  worker = "npx tsx src/worker/index.ts"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1
  processes = ["web"]

[env]
  HOSTNAME = "0.0.0.0"
  PORT = "3000"
```

- [ ] **Step 5: Verify the image builds and both entrypoints resolve**

```bash
docker build -t authgd:plan3 .
docker run --rm authgd:plan3 node -e "require('node:fs').accessSync('web/server.js'); console.log('web ok')"
docker run --rm authgd:plan3 npx tsx --version
docker run --rm authgd:plan3 sh -c "npm run db:migrate 2>&1 | head -2 || true"
```

Expected: build succeeds; `web ok`; a tsx version prints; migrate fails ONLY with `DATABASE_URL not set` (proving the script itself resolves).

- [ ] **Step 6: Commit**

```bash
git add Dockerfile .dockerignore fly.toml package.json package-lock.json
git commit -m "feat: one-image Dockerfile and Fly.io config (web + worker + release migrate)"
```

---

### Task 11: Wanderer live smoke script + operator docs

**Files:**
- Create: `scripts/wanderer-smoke.ts`, `docs/ops.md`
- Modify: `package.json` (script `"smoke:wanderer": "tsx scripts/wanderer-smoke.ts"`)
- Test: typecheck (the script hits the REAL Wanderer instance — never run in CI/tests; it is the deploy-time check itself)

**Interfaces:**
- Consumes: `loadConfig`, `createWandererClient` (Plan 2 — `getAclMembers`/`addAclMember`/`removeAclMember`, idempotent 404 delete).
- Produces: `npm run smoke:wanderer -- <characterId>` — a read → add → verify → remove → verify pass against the live ACL, refusing to touch characters already on it. Exit 0 = the confirmed-from-source client contract works live.

- [ ] **Step 1: Write the script** — `scripts/wanderer-smoke.ts`:

```ts
/**
 * Deploy-time live smoke check for the Wanderer client (Plan 2 confirmed the
 * API contract from wanderer's source but never ran it live). Performs a
 * read → add → re-read → remove → re-read pass with a THROWAWAY character id
 * you supply (any real EVE character id NOT already on the ACL — e.g. an alt).
 *
 * Usage (with production env vars exported, e.g. via `fly ssh console`):
 *   npm run smoke:wanderer -- <characterId>
 */
import { loadConfig } from "@/config";
import { createWandererClient } from "@/lib/wanderer/client";

async function main() {
  const arg = process.argv[2];
  if (!arg || !/^\d+$/.test(arg)) {
    console.error("usage: npm run smoke:wanderer -- <test character id>");
    process.exit(2);
  }
  const characterId = Number(arg);
  const cfg = loadConfig();
  const wanderer = createWandererClient(cfg);

  const before = await wanderer.getAclMembers();
  console.log(`READ ok — ${before.length} ACL members`);
  if (before.some((m) => m.characterId === characterId)) {
    console.error(
      `character ${characterId} is ALREADY on the ACL — refusing to touch a real member; use a throwaway id`,
    );
    process.exit(2);
  }

  await wanderer.addAclMember(characterId);
  let removed = false;
  try {
    const afterAdd = await wanderer.getAclMembers();
    if (!afterAdd.some((m) => m.characterId === characterId)) {
      throw new Error("ADD not visible on re-read");
    }
    console.log("ADD ok — member visible on re-read");

    await wanderer.removeAclMember(characterId);
    const afterRemove = await wanderer.getAclMembers();
    if (afterRemove.some((m) => m.characterId === characterId)) {
      throw new Error("REMOVE not visible on re-read");
    }
    // Only after absence is CONFIRMED — if the member is still present, the
    // finally block must retry the removal.
    removed = true;
    console.log("REMOVE ok — member gone on re-read");
    console.log("PASS: wanderer client contract verified live");
  } finally {
    // Never leave the throwaway character with live map access: any failure
    // after the add still attempts cleanup, loudly.
    if (!removed) {
      try {
        await wanderer.removeAclMember(characterId);
        console.error(`cleanup: removed ${characterId} from the ACL after a failure`);
      } catch (cleanupErr) {
        console.error(
          `cleanup FAILED — character ${characterId} may STILL BE ON THE ACL ` +
            `(id ${cfg.wanderer.aclId}). Remove it manually in Wanderer now.`,
          cleanupErr,
        );
      }
    }
  }
}

main().catch((err) => {
  console.error("FAIL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
```

Add to `package.json` scripts: `"smoke:wanderer": "tsx scripts/wanderer-smoke.ts",`

- [ ] **Step 2: Write the operator docs** — `docs/ops.md`:

````markdown
# authGD operations

## Deploy (Fly.io)

One image, two process groups (`web`, `worker`) plus a release command that
runs migrations before each deploy (`fly.toml`).

First deploy:

```bash
fly launch --no-deploy          # reuses fly.toml; create the app, don't deploy
fly postgres create             # or attach an existing cluster
fly postgres attach <pg-app>    # sets DATABASE_URL
fly secrets set \
  SESSION_COOKIE_NAME=authgd_session \
  TOKEN_ENCRYPTION_KEY=<base64 of 32 random bytes> \
  APP_BASE_URL=https://<app>.fly.dev \
  ALLIANCE_ID=... \
  BOOTSTRAP_ADMIN_CHARACTER_IDS=... \
  EVE_SSO_CLIENT_ID=... EVE_SSO_CLIENT_SECRET=... \
  EVE_SSO_SCOPES="esi-characters.read_contacts.v1 esi-characters.write_contacts.v1" \
  EVE_SCOPE_SET_VERSION=1 \
  DISCORD_CLIENT_ID=... DISCORD_CLIENT_SECRET=... DISCORD_BOT_TOKEN=... \
  DISCORD_GUILD_ID=... DISCORD_ROLE_ID_FLYGD=... DISCORD_ROLE_ID_BLUE=... \
  DISCORD_ROLE_ID_GREEN=... DISCORD_OPS_WEBHOOK_URL=... \
  WANDERER_BASE_URL=... WANDERER_API_KEY=... WANDERER_MAP_SLUG=... WANDERER_ACL_ID=... \
  STANDINGS_LABEL=flygd STANDINGS_VALUE=5 \
  ESI_CONTACT="you@example.com"
fly deploy
fly scale count web=1 worker=1
```

`TOKEN_ENCRYPTION_KEY`: `openssl rand -base64 32`. Rotating it invalidates
every stored EVE refresh token (members re-auth); treat it as unrotatable.

## First-deploy Wanderer smoke check

The Wanderer client contract was confirmed from wanderer's source; verify it
against YOUR live instance once, at first deploy, with a throwaway character
id (any EVE character id not already on the ACL):

```bash
fly ssh console -C "npm run smoke:wanderer -- <characterId>"
```

PASS = read/add/remove all work. The script refuses to run against a
character already on the ACL.

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string (set by `fly postgres attach`) |
| `SESSION_COOKIE_NAME` | no (default `authgd_session`) | session cookie name |
| `TOKEN_ENCRYPTION_KEY` | yes | base64, exactly 32 bytes; encrypts EVE refresh tokens at rest |
| `APP_BASE_URL` | yes | public URL; OAuth redirect URIs derive from it |
| `ALLIANCE_ID` | yes | membership anchor: main in this alliance ⇒ FlyGD |
| `BOOTSTRAP_ADMIN_CHARACTER_IDS` | no | comma-separated; see recovery caveat below |
| `EVE_SSO_CLIENT_ID` / `EVE_SSO_CLIENT_SECRET` | yes | EVE application credentials |
| `EVE_SSO_SCOPES` | yes | space-separated full scope set requested at every login |
| `EVE_SCOPE_SET_VERSION` | no (default 1) | bump when scopes change ⇒ members flagged needs_reauth |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | yes | Discord OAuth (identify only) |
| `DISCORD_BOT_TOKEN` | yes | bot with Manage Roles above the three managed roles |
| `DISCORD_GUILD_ID` | yes | the guild whose roles are managed |
| `DISCORD_ROLE_ID_FLYGD` / `_BLUE` / `_GREEN` | yes | the three managed role ids (distinct) |
| `DISCORD_OPS_WEBHOOK_URL` | no | ops alerts (final retry failures, config errors) |
| `WANDERER_BASE_URL` / `WANDERER_API_KEY` | yes | Wanderer instance + map API key |
| `WANDERER_MAP_SLUG` / `WANDERER_ACL_ID` | yes | the managed map/ACL |
| `STANDINGS_LABEL` | no (default `flygd`) | in-game contact label the app OWNS (destructive within it) |
| `STANDINGS_VALUE` | no (default 5) | standing pushed for members |
| `ESI_CONTACT` | yes | operator contact sent in the ESI User-Agent (CCP requirement) |

## Bootstrap admin — recovery caveat

The bootstrap grant is **once-ever per character id**: the first time an
account links a character listed in `BOOTSTRAP_ADMIN_CHARACTER_IDS`, a
consumed `bootstrap_admin_grant` row is written and can never fire again —
even if the account is deleted, the flag revoked, or the character sold.

**If you ever lose all admin access**, adding a previously used character id
back to the env var does nothing. Recovery requires adding a character id
that has NEVER had a grant row, then logging in with that character. Keep at
least one never-used id in reserve, or check
`select character_id from bootstrap_admin_grant` before relying on one.

## Local development

```bash
docker compose -f docker-compose.dev.yml up -d   # Postgres on :5433
npm run db:migrate && npm run dev                # web
npm run worker                                   # worker (second terminal)
npm test                                         # vitest (needs the compose DB)
npm run test:e2e                                 # Playwright (Task 12; not concurrently with npm test)
```
````

- [ ] **Step 3: Verify**

Run: `npm run typecheck` — the smoke script compiles (tsx resolves `@/` via tsconfig paths, same as the worker entry).
Expected: PASS. Do NOT run the smoke script (live instance).

- [ ] **Step 4: Commit**

```bash
git add scripts/wanderer-smoke.ts docs/ops.md package.json
git commit -m "feat: live Wanderer smoke script and operator docs"
```

---

### Task 12: Playwright smoke tests

Login-mocked (session seeded straight into the test DB + cookie set on the browser context — no OAuth involved) passes over: member account page, admin list sort/filter, tier controls, admin gating, and the login `error` param (closing the carry-over: it IS wired — `/auth/eve/callback` redirects to `/login?error=oauth_denied` and the page renders it; the e2e test pins that).

**Files:**
- Create: `playwright.config.ts`, `e2e/helpers.ts`, `e2e/account.spec.ts`, `e2e/admin.spec.ts`
- Modify: `package.json` (devDep `@playwright/test`, script `"test:e2e": "playwright test"`)
- Test: the suite itself.

**Interfaces:**
- Consumes: `createDb`, schema tables, the session-key scheme (cookie holds the raw id; the DB stores its sha256-base64url — mirror `src/services/session.ts`).
- Produces: `seedMember`, `seedAdmin`, `sessionCookieFor` helpers other e2e specs can reuse.

- [ ] **Step 1: Install and configure**

```bash
npm install -D @playwright/test
npx playwright install chromium
```

`playwright.config.ts`:

```ts
import { defineConfig } from "@playwright/test";

const TEST_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://authgd:authgd@localhost:5433/authgd_test";

// Full config env: getConfig() validates lazily per request, so the dev server
// needs every required var even though e2e never talks to EVE/Discord/Wanderer.
const env = {
  DATABASE_URL: TEST_URL,
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  APP_BASE_URL: "http://localhost:3111",
  ALLIANCE_ID: "99000001",
  BOOTSTRAP_ADMIN_CHARACTER_IDS: "",
  EVE_SSO_CLIENT_ID: "cid",
  EVE_SSO_CLIENT_SECRET: "sec",
  EVE_SSO_SCOPES: "esi-characters.read_contacts.v1 esi-characters.write_contacts.v1",
  EVE_SCOPE_SET_VERSION: "1",
  DISCORD_CLIENT_ID: "d-cid",
  DISCORD_CLIENT_SECRET: "d-sec",
  DISCORD_BOT_TOKEN: "bot",
  DISCORD_GUILD_ID: "9000",
  DISCORD_ROLE_ID_FLYGD: "10",
  DISCORD_ROLE_ID_BLUE: "11",
  DISCORD_ROLE_ID_GREEN: "12",
  WANDERER_BASE_URL: "https://wanderer.example",
  WANDERER_API_KEY: "wkey",
  WANDERER_MAP_SLUG: "map",
  WANDERER_ACL_ID: "acl-1",
  STANDINGS_LABEL: "flygd",
  STANDINGS_VALUE: "5",
  ESI_CONTACT: "ops@example.com",
};

export default defineConfig({
  testDir: "e2e",
  workers: 1, // shared test database — never parallelize
  use: { baseURL: "http://localhost:3111" },
  webServer: {
    command: "npx next dev -p 3111",
    url: "http://localhost:3111/login",
    env,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
```

Add `"test:e2e": "playwright test"` to package.json scripts.

- [ ] **Step 2: Write the helpers** — `e2e/helpers.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDb } from "../src/db";
import { account, character, session } from "../src/db/schema";

const TEST_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://authgd:authgd@localhost:5433/authgd_test";

export function testDb() {
  return createDb(TEST_URL);
}

export async function resetDb(db: ReturnType<typeof testDb>["db"]) {
  await db.execute(sql`
    TRUNCATE account, "character", discord_link, session, bootstrap_admin_grant,
      outbox, oauth_transaction, contact_sync_state, sync_run,
      wanderer_acl_observation, audit_log RESTART IDENTITY CASCADE
  `);
}

let nextCharId = 90_000_001;

export async function seedMember(
  db: ReturnType<typeof testDb>["db"],
  opts: {
    name: string;
    tier?: "flygd" | "blue" | "green";
    tierLocked?: boolean;
    status?: "active" | "cryo";
    isAdmin?: boolean;
    alts?: string[];
  },
) {
  const mainId = nextCharId++;
  // account.main_character_id's composite FK is DEFERRED — checked at COMMIT —
  // so the account and its main character MUST insert in one transaction
  // (see tests/account-view.test.ts for the same pattern).
  return db.transaction(async (tx) => {
    const [acc] = await tx
      .insert(account)
      .values({
        tier: opts.tier ?? "green",
        tierLocked: opts.tierLocked ?? false,
        status: opts.status ?? "active",
        isAdmin: opts.isAdmin ?? false,
        mainCharacterId: mainId,
      })
      .returning();
    await tx.insert(character).values({
      id: mainId,
      accountId: acc.id,
      name: opts.name,
      ownerHash: `oh-${mainId}`,
      scopes: [],
    });
    for (const altName of opts.alts ?? []) {
      const altId = nextCharId++;
      await tx.insert(character).values({
        id: altId,
        accountId: acc.id,
        name: altName,
        ownerHash: `oh-${altId}`,
        scopes: [],
      });
    }
    return acc;
  });
}

/** Mirrors src/services/session.ts: cookie carries the raw id, DB its sha256. */
export async function sessionCookieFor(
  db: ReturnType<typeof testDb>["db"],
  accountId: string,
) {
  const raw = randomBytes(32).toString("base64url");
  await db.insert(session).values({
    id: createHash("sha256").update(raw).digest("base64url"),
    accountId,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return { name: "authgd_session", value: raw, url: "http://localhost:3111" };
}
```

- [ ] **Step 3: Write the specs**

`e2e/account.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";

const { db, pool } = testDb();
test.afterAll(() => pool.end());
test.beforeEach(() => resetDb(db));

test("login page renders the wired error param", async ({ page }) => {
  await page.goto("/login?error=oauth_denied");
  await expect(page.getByRole("alert")).toContainText("cancelled");
});

test("unauthenticated /account redirects to login", async ({ page }) => {
  await page.goto("/account");
  await expect(page).toHaveURL(/\/login/);
});

test("account page shows characters, main marker, and tier", async ({ page, context }) => {
  const acc = await seedMember(db, { name: "Pilot Prime", tier: "flygd", alts: ["Pilot Alt"] });
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
  await expect(page.getByText("Pilot Prime")).toBeVisible();
  await expect(page.getByText("(main)")).toBeVisible();
  await expect(page.getByText("Pilot Alt")).toBeVisible();
  await expect(page.getByText("flygd", { exact: false })).toBeVisible();
});
```

`e2e/admin.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";

const { db, pool } = testDb();
test.afterAll(() => pool.end());
test.beforeEach(() => resetDb(db));

async function seedWorld() {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  await seedMember(db, { name: "Azzy", tier: "green", status: "cryo" });
  await seedMember(db, { name: "Zed", tier: "flygd" });
  return admin;
}

test("non-admins are redirected away from /admin", async ({ page, context }) => {
  const member = await seedMember(db, { name: "Pleb" });
  await context.addCookies([await sessionCookieFor(db, member.id)]);
  await page.goto("/admin/accounts");
  await expect(page).toHaveURL(/\/login/);
});

test("admin list sorts by name and by tier, and filters cryo", async ({ page, context }) => {
  const admin = await seedWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");
  const mains = page.locator("tbody tr td:first-child summary");
  await expect(mains).toHaveText(["Azzy", "Boss", "Zed"]); // default name asc
  await page.getByRole("link", { name: "Tier", exact: true }).click();
  await expect(mains.first()).toHaveText(/Boss|Zed/); // flygd ranks first
  await page.goto("/admin/accounts?status=cryo");
  await expect(mains).toHaveText(["Azzy"]);
});

test("tier controls: manual set locks; return-to-auto unlocks", async ({ page, context }) => {
  const admin = await seedWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");
  const zedRow = page.locator("tbody tr", { hasText: "Zed" });
  await zedRow.getByRole("button", { name: "blue", exact: true }).click();
  await expect(zedRow.getByText("🔒")).toBeVisible();
  await expect(zedRow.getByText("blue", { exact: false }).first()).toBeVisible();
  await zedRow.getByRole("button", { name: "auto" }).click();
  await expect(zedRow.getByText("🔒")).not.toBeVisible();
});
```

- [ ] **Step 4: Run the suite**

Run: `npm run test:e2e`
Expected: all specs PASS. If a selector mismatches the Task 5 markup, fix the SELECTOR (the markup is the deliverable reviewers approved). Also re-run `npm test` — must stay green.

- [ ] **Step 5: Commit**

```bash
git add playwright.config.ts e2e package.json package-lock.json
git commit -m "test: Playwright smoke suite (account page, admin sort/filter, tier controls)"
```

---

### Task 13: Queue-config repair on restart + retryable dead-letter alerts (post-merge HIGH×2)

Plan 2 post-merge review, unread before PR #2 merged. Two worker reliability holes: (a) `createQueues` only calls `createQueue`, which pg-boss implements as `ON CONFLICT DO NOTHING` — an existing queue keeps stale policy/retry/dead-letter settings forever, silently disabling singleton coalescing and ops alerts; (b) `postOpsWebhook` never throws, so the dead-letter handler completes its job even when Discord never received the alert — the alert is permanently lost. Bonus found by the same review: the ops-webhook "success" test builds `new Response("", { status: 204 })`, which THROWS in undici (204 cannot carry a body), so that test has been exercising the swallow path, not the success path.

**Files:**
- Modify: `src/worker/queues.ts`, `src/lib/ops-webhook.ts`, `src/worker/index.ts`
- Test: `tests/worker-queues.test.ts` (append), `tests/ops-webhook.test.ts` (fix fixtures + append)

**Interfaces:**
- Consumes: pg-boss v10 `updateQueue(name, options)` / `getQueue(name)` (both exist in `node_modules/pg-boss/types.d.ts`).
- Produces:
  - `createQueues(boss)` now calls `updateQueue` after every `createQueue` with the same options, so a restart repairs stale settings; the dead-letter queue itself gets the standard retry options (and no dead-letter target — it is the end of the line).
  - `postOpsWebhookOrThrow(cfg, content, fetchImpl?): Promise<void>` in `src/lib/ops-webhook.ts` — same POST, but THROWS `OpsWebhookError` on HTTP/network failure (still a silent no-op when no webhook is configured). `postOpsWebhook` becomes a best-effort wrapper around it (existing callers unchanged).
  - The dead-letter handler in `src/worker/index.ts` catches ONLY the schema-parse failure (malformed payload = permanent, log + complete) and lets webhook failures throw so pg-boss retries the alert.

- [ ] **Step 1: Write failing tests**

Append to `tests/worker-queues.test.ts`:

```ts
  it("repairs stale queue settings on startup (createQueue alone is ON CONFLICT DO NOTHING)", async () => {
    // pg-boss's Queue type requires name even on updateQueue
    await boss.updateQueue(QUEUES.contacts, {
      name: QUEUES.contacts,
      policy: "standard",
      retryLimit: 1,
      retryDelay: 1,
      retryBackoff: false,
    });
    await createQueues(boss);
    const q = await boss.getQueue(QUEUES.contacts);
    expect(q?.policy).toBe("short");
    expect(q?.retryLimit).toBe(5);
    expect(q?.deadLetter).toBe(QUEUES.deadLetter);
  });
```

In `tests/ops-webhook.test.ts`: replace every `new Response("", { status: 204 })` with `new Response(null, { status: 204 })` (the string-body form throws inside the mock and silently exercised the catch path), then append:

```ts
import { OpsWebhookError, postOpsWebhookOrThrow } from "@/lib/ops-webhook";

describe("postOpsWebhookOrThrow", () => {
  it("posts content to the configured webhook", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await postOpsWebhookOrThrow(testConfig(), "alert", fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("is still a no-op when no webhook is configured", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await postOpsWebhookOrThrow(
      testConfig({ DISCORD_OPS_WEBHOOK_URL: "" }),
      "x",
      fetchImpl as unknown as typeof fetch,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("THROWS on HTTP failure so the dead-letter job retries", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    await expect(postOpsWebhookOrThrow(testConfig(), "x", fetchImpl)).rejects.toBeInstanceOf(
      OpsWebhookError,
    );
  });

  it("THROWS on network failure", async () => {
    const fetchImpl = (async () => {
      throw new Error("down");
    }) as typeof fetch;
    await expect(postOpsWebhookOrThrow(testConfig(), "x", fetchImpl)).rejects.toBeInstanceOf(
      OpsWebhookError,
    );
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/worker-queues.test.ts tests/ops-webhook.test.ts`
Expected: repair test FAILS (policy stays `standard`); `postOpsWebhookOrThrow` FAILS (not exported).

- [ ] **Step 3: Implement**

`src/worker/queues.ts` — replace `createQueues`:

```ts
export async function createQueues(boss: PgBoss): Promise<void> {
  // Dead-letter queue: retry options apply to jobs SENT to it directly.
  // Auto-dead-lettered jobs inherit the ORIGINAL job's retry_limit (pg-boss
  // copies it in the dlq_jobs insert — src/plans.js), so failed ops alerts
  // retry ~5 times via inheritance from the job queues below.
  const dlqOptions = { name: QUEUES.deadLetter, ...RETRY };
  await boss.createQueue(QUEUES.deadLetter, dlqOptions);
  await boss.updateQueue(QUEUES.deadLetter, dlqOptions);
  for (const name of JOB_QUEUES) {
    // policy "short": singletonKey uniqueness only exists under this policy
    // (pg-boss job_i1 partial index) — standard queues ignore singletonKey.
    // Final-retry failures dead-letter into ops-dead-letter → ops webhook.
    const options = {
      name,
      policy: "short" as const,
      ...RETRY,
      deadLetter: QUEUES.deadLetter,
    };
    // createQueue is ON CONFLICT DO NOTHING: an existing queue keeps stale
    // settings, so updateQueue repairs configuration on every startup.
    // Caveat: updateQueue COALESCEs each field, so it can OVERWRITE stale
    // values but never CLEAR one (passing undefined/null keeps the old
    // value) — we always pass every field we manage, which is sufficient.
    await boss.createQueue(name, options);
    await boss.updateQueue(name, options);
  }
}
```

`src/lib/ops-webhook.ts` — replace the file body:

```ts
import type { Config } from "@/config";

export class OpsWebhookError extends Error {}

/**
 * Posts to the optional Discord ops webhook and THROWS OpsWebhookError on
 * failure. Used by the dead-letter handler, where a lost alert must retry.
 * No-op when no webhook is configured.
 */
export async function postOpsWebhookOrThrow(
  cfg: Config,
  content: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = cfg.discord.opsWebhookUrl;
  if (!url) return;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: content.slice(0, 1900) }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new OpsWebhookError(
      `ops webhook post failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) throw new OpsWebhookError(`ops webhook post failed (${res.status})`);
}

/** Best-effort variant for ordinary jobs — alerting must not break them. */
export async function postOpsWebhook(
  cfg: Config,
  content: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    await postOpsWebhookOrThrow(cfg, content, fetchImpl);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
  }
}
```

`src/worker/index.ts` — dead-letter handler: import `postOpsWebhookOrThrow`, and replace the handler body so ONLY payload parsing is caught:

```ts
  await boss.work(QUEUES.deadLetter, async ([job]) => {
    let data: z.infer<typeof deadLetterSchema>;
    try {
      data = deadLetterSchema.parse(job.data);
    } catch (err) {
      // Malformed payload is permanent — log locally and complete the job.
      console.error("dead-letter payload malformed", err);
      return;
    }
    // Throws on failure → pg-boss retries the alert (queue has RETRY options).
    await postOpsWebhookOrThrow(
      cfg,
      `authGD: job \`${data?.jobType ?? "unknown"}\` failed after final retry.`,
    );
  });
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- tests/worker-queues.test.ts tests/ops-webhook.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/queues.ts src/lib/ops-webhook.ts src/worker/index.ts tests/worker-queues.test.ts tests/ops-webhook.test.ts
git commit -m "fix: repair queue config on startup; retry lost dead-letter alerts"
```

---

### Task 14: Membership stale-run guard + affiliation response validation (post-merge MEDIUM×2)

Plan 2 post-merge review: (a) pg-boss `short` policy allows one queued job to start while another is active, so an OLDER membership run can finish last and overwrite a NEWER run's affiliation writes — and then transition tiers from stale data; (b) `resolveAffiliations` trusts every id ESI returns, even ids never requested, letting a bad response mutate arbitrary character rows (including during account-scoped runs).

**Files:**
- Modify: `src/core/affiliation.ts`, `src/jobs/membership.ts`
- Test: `tests/affiliation.test.ts` (append), `tests/membership-job.test.ts` (append)

**Interfaces:**
- Consumes: existing `resolveAffiliations`, `runMembershipJob` shapes (signatures unchanged).
- Produces:
  - `resolveAffiliations` ignores response rows whose id was not requested and duplicate rows for the same id (first wins); requested-but-omitted ids stay `unresolved` exactly as before.
  - Membership runs carry a **DB-derived ordering token captured BEFORE any external work**: `checkedAt` comes from `select clock_timestamp()` at the top of the job body, before `resolveAffiliations` issues ESI calls. A slower, older run therefore holds an OLDER token no matter how late it finishes — `new Date()` after the ESI phase would invert that.
  - Affiliation writes CAS on the token: `WHERE id = ? AND (affiliation_checked_at IS NULL OR affiliation_checked_at < <checkedAt>) RETURNING id`. Only characters whose write WON count as confirmed for the tier pass. Ties lose (strict `<`).
  - **The tier transaction re-verifies the token under lock**: a CAS win only proves the write was newest momentarily — another run can supersede it before the tier transaction runs. Inside the transaction, the main character row is locked `FOR UPDATE` FIRST (the repo's documented lock order is character before account — see the LOCK ORDER comment in `src/services/accounts.ts`) and its `affiliation_checked_at` must still EQUAL this run's token; otherwise skip. Only then is the account row locked and re-checked as today.
  - `affiliation_invalid` writes go per-id with the same guard + `RETURNING`; the audit row is written only for ids that WON and were not already flagged (checked per-id at write time, not from the pre-run snapshot); losing writes count as `stale` and are neither flagged nor audited. New count `stale` reports all lost writes.

- [ ] **Step 1: Write failing tests**

Append to `tests/affiliation.test.ts`:

```ts
  it("ignores response rows for ids that were never requested", async () => {
    const out = await resolveAffiliations([1, 2], async () => [
      ...okFor([1, 2]),
      { characterId: 999, corporationId: 9990, allianceId: 99000001 },
    ]);
    expect(out.resolved.has(999)).toBe(false);
    expect([...out.resolved.keys()].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it("keeps the first row when the response duplicates an id", async () => {
    const out = await resolveAffiliations([1], async () => [
      { characterId: 1, corporationId: 10, allianceId: 99000001 },
      { characterId: 1, corporationId: 20, allianceId: null },
    ]);
    expect(out.resolved.get(1)).toEqual({ corporationId: 10, allianceId: 99000001 });
    expect(out.unresolved).toEqual([]);
  });
```

Append to `tests/membership-job.test.ts` (inside the main describe; `character` is already in the schema import):

```ts
  it("a slower OLDER run cannot overwrite a newer overlapping run or transition on it", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
    // GENUINELY overlapping runs: the newer run executes entirely inside the
    // older run's external ESI phase — i.e. after the older run captured its
    // ordering token — then the older run comes back with stale
    // "left alliance" data and finishes last.
    let calls = 0;
    const esi = {
      postAffiliation: async (ids: number[]): Promise<Affiliation[]> => {
        calls++;
        if (calls === 1) {
          await runMembershipJob({ db: ctx.db, cfg, esi: esiWith({ 1: 99000001 }) });
        }
        return ids.map((id) => ({ characterId: id, corporationId: 1000, allianceId: null }));
      },
    };
    const result = await runMembershipJob({ db: ctx.db, cfg, esi });
    const [ch] = await ctx.db.select().from(character).where(eq(character.id, 1));
    expect(ch.allianceId).toBe(99000001); // the newer (inner) run's write survives
    const after = await getAccount(acc.id);
    expect(after.tier).toBe("flygd"); // no demotion from the stale outer read
    expect(result.counts).toMatchObject({ demoted: 0, stale: 1 });
  });

  it("a losing invalid-flag write is neither flagged nor audited, and counts stale", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
    // Same overlap shape: a newer run confirms the character VALID while the
    // older run's ESI phase is in flight; the older run then 400-bisects the
    // id to "invalid" and must lose.
    let calls = 0;
    const esi = {
      postAffiliation: async (): Promise<Affiliation[]> => {
        calls++;
        if (calls === 1) {
          await runMembershipJob({ db: ctx.db, cfg, esi: esiWith({ 1: 99000001 }) });
        }
        throw new EsiError("bad id", 400, "permanent");
      },
    };
    const result = await runMembershipJob({ db: ctx.db, cfg, esi });
    const [ch] = await ctx.db.select().from(character).where(eq(character.id, 1));
    expect(ch.affiliationInvalid).toBe(false); // losing flag write discarded
    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "character.affiliation_invalid"));
    expect(audits).toHaveLength(0);
    expect(result.counts).toMatchObject({ stale: 1 });
  });
```

(The between-CAS-and-transaction window from finding 2 is closed by the in-transaction token re-verification; the overlap tests above pin the ordering mechanism itself, and the re-verify shares the exact same equality check.)

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/affiliation.test.ts tests/membership-job.test.ts`
Expected: FAIL — unrequested id resolved; stale run demotes and overwrites.

- [ ] **Step 3: Implement**

`src/core/affiliation.ts` — in `resolveChunk`'s success path:

```ts
    const rows = await post(ids);
    const requested = new Set(ids);
    const returned = new Set<number>();
    for (const r of rows) {
      // Never trust unrequested or duplicate ids: a malformed response must
      // not mutate arbitrary character rows (first row wins on duplicates).
      if (!requested.has(r.characterId) || returned.has(r.characterId)) continue;
      returned.add(r.characterId);
      out.resolved.set(r.characterId, {
        corporationId: r.corporationId,
        allianceId: r.allianceId,
      });
    }
    for (const id of ids) if (!returned.has(id)) out.unresolved.push(id);
```

`src/jobs/membership.ts` — add `or`, `isNull`, `lt`, `sql` to the drizzle-orm import. Three coordinated changes inside the job body:

**(a) Ordering token — FIRST thing in the job body, before `resolveAffiliations`:**

```ts
    // Ordering token for this run, captured BEFORE any external work and from
    // the DATABASE clock: "short" queues allow two overlapping runs, and a
    // slower, older run must never beat a newer one just by finishing last
    // (a post-ESI `new Date()` would give the older run the LATER stamp).
    const tokenResult = await db.execute<{ now: Date }>(sql`select clock_timestamp() as now`);
    const checkedAt = tokenResult.rows[0].now;
```

(Delete the existing `const checkedAt = new Date();` line further down.)

**(b) Guarded resolved/invalid writes — replace the write loops:**

```ts
    // CAS on affiliation_checked_at: only rows whose write WON are confirmed
    // for the tier pass; a lost write means a newer run owns this character.
    const confirmed = new Set<number>();
    let stale = 0;
    const tokenGuard = (id: number) =>
      and(
        eq(character.id, id),
        or(
          isNull(character.affiliationCheckedAt),
          lt(character.affiliationCheckedAt, checkedAt),
        ),
      );
    for (const [id, aff] of outcome.resolved) {
      const won = await db
        .update(character)
        .set({
          corporationId: aff.corporationId,
          allianceId: aff.allianceId,
          affiliationCheckedAt: checkedAt,
          affiliationInvalid: false,
        })
        .where(tokenGuard(id))
        .returning({ id: character.id });
      if (won.length > 0) confirmed.add(id);
      else stale++;
    }
    for (const id of outcome.invalid) {
      // Per-id so the audit reflects rows that actually changed: RETURNING
      // proves the write won; the flag is read at write time (not from the
      // pre-run snapshot) so a losing run cannot audit a phantom flag.
      const [before] = await db
        .select({ flagged: character.affiliationInvalid })
        .from(character)
        .where(eq(character.id, id));
      const won = await db
        .update(character)
        .set({ affiliationInvalid: true, affiliationCheckedAt: checkedAt })
        .where(tokenGuard(id))
        .returning({ id: character.id });
      if (won.length === 0) {
        stale++;
        continue;
      }
      if (before && !before.flagged) {
        await logAudit(db, {
          actor: "system",
          action: "character.affiliation_invalid",
          target: String(id),
        });
      }
    }
```

(This replaces the existing bulk `inArray` invalid UPDATE and its `alreadyFlagged` pre-run snapshot loop entirely.)

**(c) Tier pass** — require `confirmed.has(acc.mainCharacterId)` wherever the main's confirmation is computed from `outcome.resolved`, and add a token re-verification INSIDE the existing tier transaction, BEFORE the account-row lock (lock order: character before account, per the LOCK ORDER comment in `src/services/accounts.ts`):

```ts
      const applied = await db.transaction(async (tx) => {
        // A CAS win is only momentary — re-verify under lock that our write
        // is STILL the latest before transitioning the tier on it.
        const [mainRow] = await tx
          .select()
          .from(character)
          .where(eq(character.id, acc.mainCharacterId!))
          .for("update");
        if (
          !mainRow ||
          mainRow.affiliationCheckedAt?.getTime() !== checkedAt.getTime()
        ) {
          return false; // superseded — the newer run owns this decision
        }
        const [locked] = await tx
          .select()
          .from(account)
          // …existing account lock + re-check + update/audit/enqueue unchanged…
```

Add `stale` to the returned counts.

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- tests/affiliation.test.ts tests/membership-job.test.ts tests/deprovision-flow.test.ts`
Expected: PASS (deprovision flow exercises the same job — it must stay green).

- [ ] **Step 5: Commit**

```bash
git add src/core/affiliation.ts src/jobs/membership.ts tests/affiliation.test.ts tests/membership-job.test.ts
git commit -m "fix: guard membership writes against stale concurrent runs; validate affiliation response ids"
```

---

### Task 15: `getGuildMember` 404 → null only for Discord code 10007 (post-merge Major)

The unread CodeRabbit comment from PR #2 (posted 5 minutes after merge): `getGuildMember` maps EVERY 404 to `null` ("not in guild"). A 404 with code `10004` (Unknown Guild — misconfigured `DISCORD_GUILD_ID`) or a malformed body then reads as "user left the guild" and the role job silently skips everyone instead of failing loudly.

**Files:**
- Modify: `src/lib/discord/rest.ts`
- Test: `tests/discord-rest.test.ts` (fix existing 404 fixture + append)

**Interfaces:**
- Consumes: existing `DiscordApiError`, `rawRequest`, `assertOk`, `parseBody`.
- Produces: `getGuildMember` returns `null` ONLY when the 404 body carries `code: 10007` (Unknown Member); any other 404 (including `10004` and malformed bodies) throws a NON-transient `DiscordApiError`. Signature unchanged; the role job's null-handling ("user not in guild → log and skip") is untouched.

- [ ] **Step 1: Update/write tests**

`tests/discord-rest.test.ts` already defines `const cfg = testConfig()` (guild `9000`), `const API = "https://discord.com/api/v10"`, and a module-scope msw `server`; each test constructs the client inline as `createDiscordClient(cfg)`. Find the existing `getGuildMember` 404 test and give its fixture a real Discord error body: `HttpResponse.json({ message: "Unknown Member", code: 10007 }, { status: 404 })` — it must still expect `null`. Then append, matching those conventions exactly:

```ts
  it("treats 404 Unknown Guild (10004) as a permanent error, not 'left the guild'", async () => {
    server.use(
      http.get(`${API}/guilds/9000/members/u1`, () =>
        HttpResponse.json({ message: "Unknown Guild", code: 10004 }, { status: 404 }),
      ),
    );
    const err = await createDiscordClient(cfg)
      .getGuildMember("u1")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiscordApiError);
    expect((err as DiscordApiError).transient).toBe(false);
  });

  it("treats a malformed 404 body as a permanent error", async () => {
    server.use(
      http.get(`${API}/guilds/9000/members/u1`, () =>
        new HttpResponse("<html>gateway</html>", { status: 404 }),
      ),
    );
    const err = await createDiscordClient(cfg)
      .getGuildMember("u1")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiscordApiError);
    expect((err as DiscordApiError).transient).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/discord-rest.test.ts`
Expected: the two new cases FAIL (both currently return `null`).

- [ ] **Step 3: Implement** — in `src/lib/discord/rest.ts`, replace the `getGuildMember` 404 branch:

```ts
    /** null ONLY for Discord code 10007 (Unknown Member — user not in guild).
     * Any other 404 (10004 Unknown Guild = bad config, malformed body) is a
     * permanent error: the role job must fail loudly, not skip everyone. */
    async getGuildMember(userId: string): Promise<{ roles: string[] } | null> {
      const path = `/guilds/${guild}/members/${userId}`;
      const res = await rawRequest(path);
      if (res.status === 404) {
        const body = (await res.json().catch(() => undefined)) as
          | { code?: number }
          | undefined;
        if (body?.code === 10007) return null;
        throw new DiscordApiError(
          `discord GET ${path} failed (404${body?.code !== undefined ? `, code ${body.code}` : ", malformed body"})`,
          { status: 404, transient: false },
        );
      }
      assertOk(res, "GET", path);
      return parseBody(memberSchema, res, "GET", path);
    },
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- tests/discord-rest.test.ts tests/discord-roles-job.test.ts`
Expected: PASS (role-job suite mocks `getGuildMember` at the client seam, so it stays green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/discord/rest.ts tests/discord-rest.test.ts
git commit -m "fix: getGuildMember returns null only for Unknown Member (10007)"
```

---

### Task 16: Final verification and wrap-up

**Files:**
- Modify: `docs/superpowers/plans/2026-08-02-authgd-plan2-3-carryover.md` (mark Plan 3 items resolved)

- [ ] **Step 1: Full verification**

```bash
npm test                 # all vitest suites
npm run typecheck
npm run build
npm run test:e2e         # after npm test finishes (shared DB)
docker build -t authgd:plan3 .
```

Expected: everything green. Then `git diff main --stat` and re-read the diff against this plan — no placeholders, no dead code, no scope creep.

- [ ] **Step 2: Close out the carry-over doc** — append to the "Plan 3 notes" section:

```markdown
All three Plan 3 notes resolved (2026-08-03, Plan 3): demoteAdmin route-gated +
ordered locking; bootstrap recovery caveat documented in docs/ops.md; login
error param confirmed wired and pinned by e2e.
```

- [ ] **Step 3: Spec coverage self-check** — confirm each is true in the diff:
  - Admin accounts page: main + expandable alts, tier + changed-at/by + lock, inline set/auto controls, cryo toggle + date + notes, token health, Discord, Map (observed_at, from `wanderer_acl_observation` only), last login, sort/filter (tier/cryo/name/tier-change date). ✔ Tasks 3+5
  - All tier/lock/status changes: audit + outbox in one transaction. ✔ Task 2
  - Audit page filterable; sync page shows last runs per job + sync-now (global on sync page, per-account on the accounts row) + recheck button. ✔ Tasks 6+7
  - Admin management grant/revoke with last-admin error surfaced. ✔ Tasks 1+5
  - Route gating incl. every server action. ✔ Tasks 4–7
  - Deployment (Dockerfile/fly.toml/migrate-on-release), ops docs incl. bootstrap caveat + env reference, Wanderer live smoke. ✔ Tasks 10+11
  - F5/F6/F7 + testJwksOverride retirement. ✔ Tasks 7–9
  - Plan 2 post-merge review findings: queue-config repair on restart, retryable dead-letter alerts (+ fixed 204 fixture), membership stale-run CAS, affiliation response-id validation, Discord 404 → 10007-only. ✔ Tasks 13–15
  - Playwright: account page, admin sort/filter, tier controls, login error param. ✔ Task 12

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-08-02-authgd-plan2-3-carryover.md
git commit -m "docs: mark Plan 3 carry-over items resolved"
```

Then use superpowers:finishing-a-development-branch (PR to main, as Plans 1/2 were).

---

## Not in this plan (deferred per spec)

- Loot payout splits, structure ACL audit, member-facing Discord notifications, multi-map support (spec "Deferred / future").
- Any visual design system — the admin UI deliberately matches the existing unstyled-HTML convention; theming is future polish.
