# Ops Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an external uptime monitor something meaningful to watch, make machine sizing declarative, and delete an environment variable that documents behavior the code does not implement.

**Architecture:** Two public JSON endpoints under `src/app/api/health/`. Staleness is decided by a pure function in `src/core/health.ts`; database access lives in `src/services/health.ts`; the route handlers only map a result to a status code. This follows the repository's existing split — `src/core/` is pure and unit-tested without a database, `src/services/` takes a `Dbx`.

**Tech Stack:** Next.js 15 App Router route handlers, Drizzle ORM, node-postgres, Vitest, Fly.io.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-03-ops-health-hardening-design.md`.
- Staleness threshold is **90 minutes**, a constant in `src/core/health.ts`. Not an environment variable.
- `src/core/` must stay pure: no database, no config, no I/O.
- Both endpoints are public. No authentication, and no account data, counts, or secrets in any response body.
- Both endpoints set `Cache-Control: no-store` and `export const dynamic = "force-dynamic"`.
- `/api/health/sync` must **never** be wired into `fly.toml`.
- **There is no lint script in this repository.** Verification is `npm test`, `npm run typecheck`, `npm run build`. Do not invent a lint step.
- Tests need the dev database running: `docker compose -f docker-compose.dev.yml up -d`. Vitest runs with `fileParallelism: false`, so database tests do not race.
- Commit after every task.

---

### Task 1: Pure freshness evaluation

**Files:**
- Create: `src/core/health.ts`
- Test: `tests/health-core.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `STALE_AFTER_MS: number`; `type Freshness = { fresh: boolean; ageSec: number | null }`; `evaluateFreshness(newestStartedAt: Date | null, now: Date, thresholdMs?: number): Freshness`. Tasks 2 and 3 depend on these exact names.

- [ ] **Step 1: Write the failing test**

Create `tests/health-core.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { STALE_AFTER_MS, evaluateFreshness } from "@/core/health";

const now = new Date("2026-08-03T12:00:00Z");

describe("evaluateFreshness", () => {
  it("is fresh for a run 30 minutes old", () => {
    expect(evaluateFreshness(new Date("2026-08-03T11:30:00Z"), now)).toEqual({
      fresh: true,
      ageSec: 1800,
    });
  });

  it("is stale for a run 3 hours old", () => {
    expect(evaluateFreshness(new Date("2026-08-03T09:00:00Z"), now)).toEqual({
      fresh: false,
      ageSec: 10800,
    });
  });

  // Pins the comparison operator: exactly at the threshold counts as fresh, so
  // a job that runs precisely on schedule can never flap the check.
  it("treats exactly the threshold as fresh", () => {
    const at = new Date(now.getTime() - STALE_AFTER_MS);
    expect(evaluateFreshness(at, now)).toEqual({ fresh: true, ageSec: 5400 });
  });

  it("treats one millisecond past the threshold as stale", () => {
    const at = new Date(now.getTime() - STALE_AFTER_MS - 1);
    expect(evaluateFreshness(at, now).fresh).toBe(false);
  });

  // "The worker has never run" is the exact failure this endpoint exists to
  // catch, so no rows must not read as healthy.
  it("treats no rows as stale with a null age", () => {
    expect(evaluateFreshness(null, now)).toEqual({ fresh: false, ageSec: null });
  });

  it("honours an explicit threshold override", () => {
    const at = new Date(now.getTime() - 60_000);
    expect(evaluateFreshness(at, now, 30_000).fresh).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/health-core.test.ts`
Expected: FAIL — cannot resolve `@/core/health`.

- [ ] **Step 3: Write the implementation**

Create `src/core/health.ts`:

```ts
/**
 * The most frequent job (membership) runs every 30 minutes
 * (src/worker/queues.ts). 90 minutes is three missed ticks: long enough that a
 * slow run or a single retry never pages, short enough that a dead worker is
 * caught within the hour. Deliberately a constant and not an environment
 * variable — a second knob would drift from the schedules in queues.ts.
 */
export const STALE_AFTER_MS = 90 * 60 * 1000;

export type Freshness = { fresh: boolean; ageSec: number | null };

export function evaluateFreshness(
  newestStartedAt: Date | null,
  now: Date,
  thresholdMs: number = STALE_AFTER_MS,
): Freshness {
  if (!newestStartedAt) return { fresh: false, ageSec: null };
  const ageMs = now.getTime() - newestStartedAt.getTime();
  return { fresh: ageMs <= thresholdMs, ageSec: Math.floor(ageMs / 1000) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/health-core.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/health.ts tests/health-core.test.ts
git commit -m "feat: pure sync-run freshness evaluation"
```

---

### Task 2: Health service layer

**Files:**
- Create: `src/services/health.ts`
- Test: `tests/health-service.test.ts`

**Interfaces:**
- Consumes: `Dbx` from `@/db`, `syncRun` from `@/db/schema`.
- Produces: `checkLiveness(dbx: Dbx): Promise<boolean>` and `newestSyncRun(dbx: Dbx): Promise<{ jobType: string; startedAt: Date } | null>`. Task 3 calls both.

- [ ] **Step 1: Write the failing test**

Create `tests/health-service.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "@/db";
import { syncRun } from "@/db/schema";
import { checkLiveness, newestSyncRun } from "@/services/health";
import { setupTestDb, truncateAll } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;

beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(async () => {
  await ctx.cleanup();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
});

describe("checkLiveness", () => {
  it("is true against a reachable database", async () => {
    expect(await checkLiveness(ctx.db)).toBe(true);
  });

  // The failure branch is exercised for real rather than assumed: port 1 has
  // no listener, so the pool fails to connect.
  it("is false when Postgres is unreachable", async () => {
    const bad = createDb("postgres://nobody:nobody@127.0.0.1:1/none");
    expect(await checkLiveness(bad.db)).toBe(false);
    await bad.pool.end();
  });
});

describe("newestSyncRun", () => {
  it("returns null when no runs are recorded", async () => {
    expect(await newestSyncRun(ctx.db)).toBeNull();
  });

  it("returns the most recently inserted run regardless of job type", async () => {
    await ctx.db.insert(syncRun).values({ jobType: "purge" });
    await ctx.db.insert(syncRun).values({ jobType: "membership" });
    const row = await newestSyncRun(ctx.db);
    expect(row?.jobType).toBe("membership");
    expect(row?.startedAt).toBeInstanceOf(Date);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/health-service.test.ts`
Expected: FAIL — cannot resolve `@/services/health`.

- [ ] **Step 3: Write the implementation**

Create `src/services/health.ts`:

```ts
import { desc, sql } from "drizzle-orm";
import type { Dbx } from "@/db";
import { syncRun } from "@/db/schema";

/** Cheapest possible proof that a backend is reachable and answering. */
export async function checkLiveness(dbx: Dbx): Promise<boolean> {
  try {
    await dbx.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Newest run by serial primary key, NOT by max(started_at): the only index is
 * (job_type, id desc), so max(started_at) would seq-scan a table growing ~122
 * rows/day. started_at defaults to insert time, so id order and insertion order
 * can only disagree by the width of a race — far below a 90-minute threshold.
 */
export async function newestSyncRun(
  dbx: Dbx,
): Promise<{ jobType: string; startedAt: Date } | null> {
  const rows = await dbx
    .select({ jobType: syncRun.jobType, startedAt: syncRun.startedAt })
    .from(syncRun)
    .orderBy(desc(syncRun.id))
    .limit(1);
  return rows[0] ?? null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/health-service.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/health.ts tests/health-service.test.ts
git commit -m "feat: health service queries for liveness and newest sync run"
```

---

### Task 3: The two route handlers

**Files:**
- Create: `src/app/api/health/route.ts`
- Create: `src/app/api/health/sync/route.ts`
- Test: `tests/health-routes.test.ts`
- Test: `tests/health-routes-db-down.test.ts`

**Interfaces:**
- Consumes: `evaluateFreshness`, `STALE_AFTER_MS` (Task 1); `checkLiveness`, `newestSyncRun` (Task 2); `getDb` from `@/db`.
- Produces: `GET` handlers at `/api/health` and `/api/health/sync`. Response bodies are exactly `{"ok":true,"db":"ok"}` / `{"ok":false,"db":"error"}` and `{"ok":boolean,"newestRunAgeSec":number|null,"newestJobType":string|null}`.

Two test files because `vi.mock` is hoisted per file: the database-down case needs `@/db` mocked, and the other cases need it real.

- [ ] **Step 1: Write the failing tests**

Create `tests/health-routes.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { syncRun } from "@/db/schema";
import { setupTestDb, truncateAll, TEST_URL } from "./helpers/db";

// Route modules resolve the database lazily via getDb(); set env before import.
process.env.DATABASE_URL = TEST_URL;

const { GET: healthRoute } = await import("@/app/api/health/route");
const { GET: syncRoute } = await import("@/app/api/health/sync/route");

let ctx: Awaited<ReturnType<typeof setupTestDb>>;

beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(async () => {
  await ctx.cleanup();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
});

describe("GET /api/health", () => {
  it("returns 200 and no-store when the database answers", async () => {
    const res = await healthRoute();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: "ok" });
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});

describe("GET /api/health/sync", () => {
  it("returns 503 and the documented null shape when no run exists", async () => {
    const res = await syncRoute();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      newestRunAgeSec: null,
      newestJobType: null,
    });
  });

  it("returns 200 for a run just recorded", async () => {
    await ctx.db.insert(syncRun).values({ jobType: "membership" });
    const res = await syncRoute();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.newestJobType).toBe("membership");
    expect(body.newestRunAgeSec).toBeLessThan(60);
  });

  it("returns 503 naming the stale job when the newest run is 3 hours old", async () => {
    await ctx.db.insert(syncRun).values({
      jobType: "membership",
      startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
    });
    const res = await syncRoute();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.newestJobType).toBe("membership");
    expect(body.newestRunAgeSec).toBeGreaterThan(10_000);
  });

  // A failed run still proves the worker is alive; job failures are /admin/sync's
  // job, not this endpoint's.
  it("counts a failed run as fresh", async () => {
    await ctx.db
      .insert(syncRun)
      .values({ jobType: "contacts", status: "failed", errorSummary: "boom" });
    const res = await syncRoute();
    expect(res.status).toBe(200);
  });

  it("sets no-store", async () => {
    const res = await syncRoute();
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});
```

Create `tests/health-routes-db-down.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

// The whole point of this file: exercise the 503 branch instead of assuming it.
vi.mock("@/db", () => ({
  getDb: () => ({
    execute: async () => {
      throw new Error("connection refused");
    },
  }),
}));

const { GET: healthRoute } = await import("@/app/api/health/route");

describe("GET /api/health with the database down", () => {
  it("returns 503", async () => {
    const res = await healthRoute();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, db: "error" });
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/health-routes.test.ts tests/health-routes-db-down.test.ts`
Expected: FAIL — cannot resolve `@/app/api/health/route`.

- [ ] **Step 3: Write the route handlers**

Create `src/app/api/health/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { checkLiveness } from "@/services/health";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Liveness only: this process serves, and Postgres answers. Safe to wire to
 * Fly's http_service checks. Worker health deliberately lives at
 * /api/health/sync so a stalled worker cannot pull web machines out of rotation.
 */
export async function GET() {
  const ok = await checkLiveness(getDb());
  return NextResponse.json(
    { ok, db: ok ? "ok" : "error" },
    { status: ok ? 200 : 503, headers: NO_STORE },
  );
}
```

Create `src/app/api/health/sync/route.ts`:

```ts
import { NextResponse } from "next/server";
import { evaluateFreshness } from "@/core/health";
import { getDb } from "@/db";
import { newestSyncRun } from "@/services/health";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Worker freshness. NEVER wire this into fly.toml: a stalled worker would pull
 * healthy web machines out of rotation and could stall a deploy that was never
 * unhealthy. It exists for the external uptime monitor.
 */
export async function GET() {
  const newest = await newestSyncRun(getDb());
  const { fresh, ageSec } = evaluateFreshness(newest?.startedAt ?? null, new Date());
  return NextResponse.json(
    { ok: fresh, newestRunAgeSec: ageSec, newestJobType: newest?.jobType ?? null },
    { status: fresh ? 200 : 503, headers: NO_STORE },
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/health-routes.test.ts tests/health-routes-db-down.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Run the full suite, typecheck, and build**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass. The build must list `/api/health` and `/api/health/sync` as dynamic (ƒ) routes, not static (○). If either is marked static, `dynamic = "force-dynamic"` is missing and the check would serve a cached verdict.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/health tests/health-routes.test.ts tests/health-routes-db-down.test.ts
git commit -m "feat: /api/health liveness and /api/health/sync worker freshness endpoints"
```

---

### Task 4: Remove EVE_SCOPE_SET_VERSION

**Files:**
- Modify: `src/config.ts:39` (schema entry) and `src/config.ts:77` (`scopeSetVersion` field)
- Modify: `.env.example`
- Modify: `tests/config.test.ts:13`
- Modify: `tests/helpers/config.ts:14`
- Modify: `playwright.config.ts:17`
- Modify: `docs/ops.md` (env table row, and the `fly secrets set` block)
- Modify: `docs/superpowers/specs/2026-08-02-authgd-design.md:117`

**Interfaces:**
- Consumes: nothing.
- Produces: `Config["eveSso"]` no longer has a `scopeSetVersion` field.

Context for whoever runs this: the variable is parsed and exposed but read nowhere. Bumping it flags nobody. Re-auth flagging comes from comparing stored scopes against `EVE_SSO_SCOPES` in `src/jobs/token-health.ts:96-118`. The variable documents behavior that does not exist, which is worse than having no variable.

- [ ] **Step 1: Confirm it is genuinely unused**

Run: `grep -rn "scopeSetVersion\|EVE_SCOPE_SET_VERSION" src/`
Expected: exactly two hits, both in `src/config.ts`. If anything else appears, stop — the premise of this task is wrong and the spec needs revisiting.

- [ ] **Step 2: Delete the config schema entry and the field**

In `src/config.ts`, delete the line:

```ts
  EVE_SCOPE_SET_VERSION: z.coerce.number().int().positive().default(1),
```

and inside `loadConfig`'s `eveSso` object, delete:

```ts
      scopeSetVersion: e.EVE_SCOPE_SET_VERSION,
```

- [ ] **Step 3: Delete the four remaining references**

- `.env.example`: delete the `EVE_SCOPE_SET_VERSION=1` line.
- `tests/config.test.ts`: delete the `EVE_SCOPE_SET_VERSION: "1",` line.
- `tests/helpers/config.ts`: delete the `EVE_SCOPE_SET_VERSION: "1",` line.
- `playwright.config.ts`: delete the `EVE_SCOPE_SET_VERSION: "1",` line.

- [ ] **Step 4: Fix the documentation**

In `docs/ops.md`, delete this row from the environment table:

```
| `EVE_SCOPE_SET_VERSION` | no (default 1) | bump when scopes change ⇒ members flagged needs_reauth |
```

and delete `EVE_SCOPE_SET_VERSION=1 \` from the `fly secrets set` block.

In `docs/superpowers/specs/2026-08-02-authgd-design.md:117`, the sentence currently opens with a claim the code never implemented. Change:

```
- **Scope evolution:** the configured scope set carries a version. The token health job
```

to:

```
- **Scope evolution:** the token health job
```

The rest of that bullet describes the mechanism that actually exists and stays exactly as written.

- [ ] **Step 5: Verify**

Run: `grep -rn "scopeSetVersion\|EVE_SCOPE_SET_VERSION" . --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git`
Expected: hits only inside `docs/superpowers/plans/` and `docs/superpowers/specs/2026-08-03-*` (this plan and its spec, which describe the removal). Any hit in `src/`, `tests/`, `e2e/`, `.env.example`, `playwright.config.ts`, or `docs/ops.md` means a step was missed.

Run: `npm test && npm run typecheck`
Expected: PASS. The config tests still pass because the variable was optional with a default; nothing asserted on it.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts .env.example tests/config.test.ts tests/helpers/config.ts playwright.config.ts docs/ops.md docs/superpowers/specs/2026-08-02-authgd-design.md
git commit -m "chore: remove EVE_SCOPE_SET_VERSION, which was parsed but never read"
```

---

### Task 5: Fly configuration and operations documentation

**Files:**
- Modify: `fly.toml`
- Modify: `src/db/index.ts:5-11` (the pool-count comment)
- Modify: `docs/ops.md`

**Interfaces:**
- Consumes: `/api/health` from Task 3.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Add the health check and VM sizing to fly.toml**

Append to `fly.toml`:

```toml
# web only. /api/health/sync is deliberately absent: a failing check pulls the
# machine out of the load balancer and gates deploys, so wiring worker freshness
# here would take the site down over a fault unrelated to serving pages.
[[http_service.checks]]
  interval = "30s"
  timeout = "5s"
  grace_period = "10s"
  method = "GET"
  path = "/api/health"

# Sizing declared here rather than left in `fly scale` state, so it is reviewable
# and cannot drift silently. The worker runs tsx and transpiles at runtime, which
# is why 256mb was the riskier setting for it than for the compiled web server.
[[vm]]
  memory = "512mb"
  cpu_kind = "shared"
  cpus = 1
  processes = ["web"]

[[vm]]
  memory = "512mb"
  cpu_kind = "shared"
  cpus = 1
  processes = ["worker"]
```

- [ ] **Step 2: Validate the configuration parses**

Run: `fly config validate`
Expected: "Configuration is valid". If `flyctl` is not installed or not authenticated, skip this step and say so explicitly in the task report rather than claiming it passed.

- [ ] **Step 3: Correct the pool-count comment**

In `src/db/index.ts`, the comment says the app opens three pools. At `web=2` it opens four. Change:

```
 * app opens three of them against one small Postgres — web, worker, and pg-boss
```

to:

```
 * app opens one per web machine plus worker and pg-boss against one small
 * Postgres — four at web=2
```

- [ ] **Step 4: Document monitoring and the sizing/redundancy decisions**

Add to `docs/ops.md`, after the "Deploy (Fly.io)" section:

````markdown
## Monitoring

Two public endpoints, deliberately separate:

| Endpoint | 200 means | 503 means |
|---|---|---|
| `/api/health` | this web machine serves and Postgres answers | the process is up but the database is unreachable |
| `/api/health/sync` | a sync job ran within the last 90 minutes | the worker is dead, wedged, or has never run |

Only `/api/health` is wired into `fly.toml`. A failing Fly check removes the
machine from the load balancer and gates deploys, so pointing it at worker
freshness would take the site down over a fault that has nothing to do with
serving pages.

Point an external uptime monitor at **both** URLs. Fly cannot tell you it is
down; that is the entire reason the external check exists.

Notes:

- A `failed` run still counts as fresh. The endpoint measures whether the worker
  is alive, not whether jobs succeed — job failures belong to `/admin/sync` and
  the ops webhook. Folding them in would let one permanent config error hold the
  check red forever and train you to ignore it.
- A brand-new deploy reads 503 on `/api/health/sync` until the first `membership`
  tick, up to 30 minutes. This is intended: "never ran" is a real failure.
- The 90-minute threshold is a constant in `src/core/health.ts`. If you change a
  schedule in `src/worker/queues.ts` to something slower than 90 minutes for the
  most frequent job, change it there too.

## Sizing and redundancy — decisions, not defaults

- **512MB for both web and worker**, declared as `[[vm]]` blocks in `fly.toml`.
  The worker runs `tsx` and transpiles at runtime, so it carried the real OOM
  risk; both were raised to keep the groups uniform.
- **`web=2`** closes the deploy gap that `web=1` creates. The web tier is
  stateless — sessions and OAuth PKCE state are both in Postgres — so extra
  instances are safe. Set it with `fly scale count web=2`; machine count is not a
  `fly.toml` field.
- **`worker=1`, deliberately.** The Wanderer reconcile is destructive; a second
  worker is not a change to make casually.
- **Single-node Postgres, deliberately.** HA adds real operational weight to an
  unmanaged `postgres-flex` cluster you already patch yourself.

**Before scaling to `web=2`, check connection headroom:**

```bash
fly postgres connect -a <pg-app> -c 'SHOW max_connections'
```

| Source | Connections |
|---|---|
| web pools (2 machines × `max` 5) | 10 |
| worker `createDb` pool | 5 |
| worker pg-boss pool | 5 |
| **steady state** | **20** |
| release command (capped at 1) | +1 |
| rolling replacement overlap, worst case | +15 |
| **deploy peak, worst case** | **~36** |

Confirm headroom above ~36 including superuser-reserved connections. If it is
short, lower the per-pool `max` in `src/db/index.ts` rather than skipping the
check.
````

- [ ] **Step 5: Verify**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add fly.toml src/db/index.ts docs/ops.md
git commit -m "ops: declare 512mb vm sizing, wire /api/health check, document monitoring"
```

---

## Post-merge operational follow-up

Not code, and not this plan's tasks — but this work is not finished until these happen. They belong in the runbooks pass:

1. `fly scale count web=2`, after the `SHOW max_connections` check above.
2. Register both health URLs with an external uptime monitor.
3. `fly secrets unset EVE_SCOPE_SET_VERSION`.
4. Confirm `/api/health/sync` goes green within 30 minutes of deploy.

## Known merge conflict

`docs/ops.md` is also edited by the unmerged `worktree-standings-label-authgd`
branch, which changes the `STANDINGS_LABEL` default from `FLYGD` to `authgd` in
the same environment table this plan edits. Whichever merges second will need to
resolve that table. The edits do not overlap semantically — one deletes a row,
the other changes a default.
