# Structure Damage Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Monitor the corp's own Upwell structures and post a Discord alert when one takes damage.

**Architecture:** One designated character ("the holder") grants two opt-in ESI scopes. An hourly `structures` job keeps a roster; a ten-minute `structure-events` job polls that character's notifications, records the four damage types keyed by ESI's own `notification_id`, and posts each newly-recorded one to a Discord webhook. Delivery is at-least-once via a `pending` → `sent` status on each event row. An admin page at `/admin/structures` renders the roster and states what is wrong when it is.

**Tech Stack:** Next.js 16 App Router, Drizzle ORM + Postgres, pg-boss, zod 4, vitest, Playwright.

**Spec:** `docs/specs/2026-08-24-structure-monitor-design.md`

## Global Constraints

- Node `>=24`. zod is v4 — `z.object({...}).strict()`, and `{ error: "..." }` not `{ message: "..." }`.
- **No new dependencies.** In particular no YAML library; Task 2 hand-rolls the parser.
- **Migrations are generated, never hand-written.** Run `npm run db:generate` after a schema edit. Never edit a migration already applied.
- **Enqueue, don't execute.** The web tier writes an outbox row via `enqueueSync` and returns. No server action, page, or route calls ESI.
- **`src/core/` is pure.** No imports from `@/db`, `@/services`, `@/lib`, no I/O. Types only.
- **Every state change writes an audit row inside the same transaction** as the change.
- **Never claim a command passed without running it.** Cite output.
- Run `npm run format:check` in every task, not only at the end.
- Unit tests run against real Postgres (port 5433, provisioned by the test helpers). e2e runs `workers: 1`, `retries: 0` — do not raise either.
- The four notification types, spelled exactly: `StructureUnderAttack`, `StructureLostShields`, `StructureLostArmor`, `StructureDestroyed`.

---

### Task 1: Schema, enums, and migration

**Files:**

- Modify: `src/db/schema.ts`
- Modify: `src/db/tables.ts:14-38`
- Create: `drizzle/00NN_*.sql` (generated)
- Test: `tests/structure-schema.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `structureHolder`, `structureReadState`, `structure`, `structureEvent` table objects; `structureReadStatusEnum` / `StructureReadStatus`; `structureAlertStatusEnum` / `StructureAlertStatus`.

- [ ] **Step 1: Write the failing test**

Create `tests/structure-schema.test.ts`:

```ts
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { MANAGED_TABLE_NAMES } from "@/db/tables";

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

describe("structure monitor schema", () => {
  it("registers all four tables in MANAGED_TABLES", () => {
    for (const t of [
      "structure_holder",
      "structure_read_state",
      "structure",
      "structure_event",
    ]) {
      expect(MANAGED_TABLE_NAMES).toContain(t);
    }
  });

  it("pins structure_holder to a single row", async () => {
    const account = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, testConfig(), { id: 90000001, accountId: account.id });
    await ctx.db.execute(
      sql`insert into structure_holder (id, character_id, corporation_id, designated_by) values (1, 90000001, 5, 'system')`,
    );
    await expect(
      ctx.db.execute(
        sql`insert into structure_holder (id, character_id, corporation_id, designated_by) values (2, 90000001, 5, 'system')`,
      ),
    ).rejects.toThrow();
  });

  it("keys structure_read_state by (kind, corporation_id)", async () => {
    await ctx.db.execute(
      sql`insert into structure_read_state (kind, corporation_id, last_attempt_at, read_status) values ('roster', 98000001, now(), 'ok')`,
    );
    await ctx.db.execute(
      sql`insert into structure_read_state (kind, corporation_id, last_attempt_at, read_status) values ('roster', 98000002, now(), 'ok')`,
    );
    await expect(
      ctx.db.execute(
        sql`insert into structure_read_state (kind, corporation_id, last_attempt_at, read_status) values ('roster', 98000001, now(), 'ok')`,
      ),
    ).rejects.toThrow();
  });

  it("carries all four alert statuses", async () => {
    const res = await ctx.db.execute(
      sql`select unnest(enum_range(null::structure_alert_status))::text as v`,
    );
    const values = res.rows.map((r) => (r as { v: string }).v);
    expect(values.sort()).toEqual(["abandoned", "pending", "seeded", "sent"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/structure-schema.test.ts`
Expected: FAIL — `relation "structure_holder" does not exist`.

- [ ] **Step 3: Add the enums to `src/db/schema.ts`**

Place beside the other `pgEnum` declarations near the top (after `accessListEntryKindEnum`):

```ts
export const structureReadStatusEnum = pgEnum("structure_read_status", [
  "ok",
  "forbidden",
  "failed",
]);
export type StructureReadStatus = (typeof structureReadStatusEnum.enumValues)[number];

/**
 * Four distinct states, not shades of one.
 *
 * `seeded`    — recorded without alerting: this holder had never polled, or no
 *               webhook is configured so there is no recipient.
 * `pending`   — recorded and owed an alert.
 * `sent`      — posted successfully.
 * `abandoned` — was pending when the holder was replaced, and will never be
 *               posted.
 *
 * `abandoned` is not a reuse of `seeded` because the two answer different
 * questions: "deliberately not alerted" versus "owed an alert with no valid
 * recipient". Collapsing them makes it impossible to tell from the table
 * whether a holder swap swallowed a live attack.
 */
export const structureAlertStatusEnum = pgEnum("structure_alert_status", [
  "seeded",
  "pending",
  "sent",
  "abandoned",
]);
export type StructureAlertStatus = (typeof structureAlertStatusEnum.enumValues)[number];
```

- [ ] **Step 4: Add the four tables to `src/db/schema.ts`**

Append after the access-list tables:

```ts
/**
 * The designated structure holder. Singleton, like `access_list_holder`.
 *
 * `corporationId` is PINNED at designation rather than read live off
 * `character.corporationId`, which the membership job overwrites every thirty
 * minutes (src/jobs/membership.ts:125). Following it live means a holder who
 * changes corp silently re-rosters against the new corp and stamps
 * `missingSince` on every previous structure — indistinguishable from a mass
 * destruction event, arriving during the exact incident this tool exists for.
 *
 * `seededAt` null means this holder has never completed a poll: the events job
 * records without alerting until it is stamped. `designateHolder` writes it
 * null, so replacing the holder re-seeds.
 */
export const structureHolder = pgTable(
  "structure_holder",
  {
    id: integer("id").primaryKey(),
    characterId: bigint("character_id", { mode: "number" })
      .notNull()
      .references(() => character.id, { onDelete: "cascade" }),
    corporationId: bigint("corporation_id", { mode: "number" }).notNull(),
    designatedAt: timestamp("designated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    designatedBy: text("designated_by").notNull(), // account uuid or "system"
    seededAt: timestamp("seeded_at", { withTimezone: true }),
  },
  (t) => [check("structure_holder_singleton_ck", sql`${t.id} = 1`)],
);

/**
 * Read health, one row per (kind, corporation). Two timestamps for the reason
 * `access_list_snapshot` gives: `observedAt` is the last SUCCESSFUL read and is
 * null until there is one; `lastAttemptAt` + `readStatus` + `detail` describe
 * the most recent attempt either way.
 *
 * Keyed by corporation because the row describes a read against one specific
 * corp. Without it, replacing the holder leaves the previous corp's freshness
 * and 403 state in place and the page calls the new monitor healthy on the
 * strength of a read against a corp it no longer watches.
 */
export const structureReadState = pgTable(
  "structure_read_state",
  {
    kind: text("kind").notNull(), // 'roster' | 'events'
    corporationId: bigint("corporation_id", { mode: "number" }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }).notNull(),
    readStatus: structureReadStatusEnum("read_status").notNull(),
    detail: text("detail"),
  },
  (t) => [primaryKey({ columns: [t.kind, t.corporationId] })],
);

/**
 * The roster. `state` is stored verbatim as text, not a pgEnum: a state string
 * CCP adds next patch must not be able to fail a read of a field nothing
 * branches on for correctness.
 *
 * `typeName` is denormalized because there is no type-id name cache to use —
 * `universe_name`'s kind enum has no `type` value and `resolveEntityNames`
 * deliberately drops inventory types (src/services/entity-names.ts:76-80).
 *
 * A structure that stops appearing gets `missingSince` stamped, never deleted:
 * never remove on unknown state. From the roster's side a destroyed Astrahus
 * and a 403 are identical; only the event stream tells them apart.
 */
export const structure = pgTable("structure", {
  structureId: bigint("structure_id", { mode: "number" }).primaryKey(),
  corporationId: bigint("corporation_id", { mode: "number" }).notNull(),
  typeId: bigint("type_id", { mode: "number" }).notNull(),
  typeName: text("type_name"),
  systemId: bigint("system_id", { mode: "number" }).notNull(),
  name: text("name"),
  state: text("state").notNull(),
  stateTimerStart: timestamp("state_timer_start", { withTimezone: true }),
  stateTimerEnd: timestamp("state_timer_end", { withTimezone: true }),
  fuelExpires: timestamp("fuel_expires", { withTimezone: true }),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  missingSince: timestamp("missing_since", { withTimezone: true }),
});

/**
 * One row per structure notification ever seen. ESI's own `notification_id` is
 * the primary key, which is what makes "seen" idempotent across runs.
 *
 * `corporationId` is stamped at insert from the holder's PINNED corp, not
 * parsed from the body. It is what the sender filters on, so a row recorded
 * under a previous holder can never be posted under a new one.
 *
 * `details` holds ONLY the parsed subset actually rendered. The notifications
 * endpoint returns every notification type for the character — war decs, mail,
 * kill rights, corp applications — and this job persists none of them.
 */
export const structureEvent = pgTable(
  "structure_event",
  {
    notificationId: bigint("notification_id", { mode: "number" }).primaryKey(),
    type: text("type").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    structureId: bigint("structure_id", { mode: "number" }),
    corporationId: bigint("corporation_id", { mode: "number" }).notNull(),
    alertStatus: structureAlertStatusEnum("alert_status").notNull(),
    details: jsonb("details").$type<Record<string, string | number | null>>(),
  },
  // Serves the sender's hot path: pending rows for the pinned corp, oldest
  // first. Without it that is a full scan of a table that only grows.
  (t) => [
    index("structure_event_pending_idx").on(t.corporationId, t.alertStatus, t.sentAt),
  ],
);
```

Add `primaryKey` to the `drizzle-orm/pg-core` import list at the top of the file.

- [ ] **Step 5: Register the tables**

In `src/db/tables.ts`, add to `MANAGED_TABLES` after `"esi_entity_name"`:

```ts
  "structure_holder",
  "structure_read_state",
  "structure",
  "structure_event",
```

- [ ] **Step 6: Generate and apply the migration**

```bash
npm run db:generate
npm run db:migrate
```

Read the generated SQL before continuing. It must contain two `CREATE TYPE`
statements and four `CREATE TABLE`s, and must not `ALTER` any existing table.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/structure-schema.test.ts tests/seed-dev.test.ts`
Expected: PASS. `tests/seed-dev.test.ts` asserts `MANAGED_TABLES` equals the
database's table list in both directions, so it fails if step 5 was missed.

- [ ] **Step 8: Format and commit**

```bash
npm run format:check
git add src/db/schema.ts src/db/tables.ts drizzle tests/structure-schema.test.ts
git commit -m "feat(structures): schema for the structure damage monitor"
```

---

### Task 2: Pure notification parsing and formatting

**Files:**

- Create: `src/core/structure-event.ts`
- Test: `tests/structure-event.test.ts`

**Interfaces:**

- Consumes: nothing (pure module, types only).
- Produces:
  - `STRUCTURE_EVENT_TYPES: readonly string[]`
  - `isStructureEventType(type: string): boolean`
  - `parseNotificationBody(text: string): Record<string, string>`
  - `type ParsedStructureEvent = { structureId: number | null; details: Record<string, string | number | null> }`
  - `extractStructureEvent(text: string): ParsedStructureEvent`
  - `formatStructureAlert(input: StructureAlertInput): string`
  - `compareRosterRows(a: RosterSortable, b: RosterSortable): number`

**Critical detail:** EVE notification bodies are **not** flat `key: value`. They
contain block sequences and YAML anchors:

```yaml
allianceName: Northern Coalition.
armorPercentage: 100.0
corpName: Ceptaerin
hullPercentage: 100.0
shieldPercentage: 94.98
solarsystemID: 30004268
structureID: &id001 1029209158734
structureShowInfoData:
  - showinfo
  - 35832
  - *id001
structureTypeID: 35832
```

The parser must skip list-item lines, strip a leading `&anchor` from a scalar,
and resolve `*alias` against the anchors it has seen. A parser that ignores
anchors reads `structureID` as the string `"&id001 1029209158734"` and every
alert loses its structure.

- [ ] **Step 1: Write the failing test**

Create `tests/structure-event.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  compareRosterRows,
  extractStructureEvent,
  formatStructureAlert,
  isStructureEventType,
  parseNotificationBody,
  STRUCTURE_EVENT_TYPES,
} from "@/core/structure-event";

const UNDER_ATTACK = `allianceID: 99005338
allianceName: Northern Coalition.
armorPercentage: 100.0
charID: 96068617
corpName: Ceptaerin
hullPercentage: 100.0
shieldPercentage: 94.98
solarsystemID: 30004268
structureID: &id001 1029209158734
structureShowInfoData:
- showinfo
- 35832
- *id001
structureTypeID: 35832`;

const LOST_SHIELDS = `solarsystemID: 30004268
structureID: &id001 1029209158734
structureShowInfoData:
- showinfo
- 35832
- *id001
structureTypeID: 35832
timeLeft: 892668963753
vulnerableTime: 9000000000`;

describe("STRUCTURE_EVENT_TYPES", () => {
  it("is exactly the four damage types", () => {
    expect([...STRUCTURE_EVENT_TYPES].sort()).toEqual([
      "StructureDestroyed",
      "StructureLostArmor",
      "StructureLostShields",
      "StructureUnderAttack",
    ]);
  });

  it("rejects non-damage structure notifications", () => {
    expect(isStructureEventType("StructureFuelAlert")).toBe(false);
    expect(isStructureEventType("StructureUnderAttack")).toBe(true);
  });
});

describe("parseNotificationBody", () => {
  it("strips a YAML anchor from a scalar", () => {
    expect(parseNotificationBody(UNDER_ATTACK).structureID).toBe("1029209158734");
  });

  it("skips block sequence items", () => {
    expect(parseNotificationBody(UNDER_ATTACK)).not.toHaveProperty("showinfo");
    expect(parseNotificationBody(UNDER_ATTACK).structureShowInfoData).toBeUndefined();
  });

  it("resolves an alias to its anchor's value", () => {
    const parsed = parseNotificationBody("a: &x 42\nb: *x");
    expect(parsed.b).toBe("42");
  });

  it("returns an empty object for junk rather than throwing", () => {
    expect(parseNotificationBody("!!! not yaml at all")).toEqual({});
  });
});

describe("extractStructureEvent", () => {
  it("pulls the structure id and the damage percentages", () => {
    const e = extractStructureEvent(UNDER_ATTACK);
    expect(e.structureId).toBe(1029209158734);
    expect(e.details.shieldPercentage).toBe(94.98);
    expect(e.details.corpName).toBe("Ceptaerin");
    expect(e.details.allianceName).toBe("Northern Coalition.");
  });

  it("returns a null structure id when the body will not parse", () => {
    const e = extractStructureEvent("garbage");
    expect(e.structureId).toBeNull();
    expect(e.details).toEqual({});
  });

  it("keeps timeLeft for a reinforcement notification", () => {
    expect(extractStructureEvent(LOST_SHIELDS).details.timeLeft).toBe(892668963753);
  });
});

describe("formatStructureAlert", () => {
  it("names the structure, the system and the attacker", () => {
    const line = formatStructureAlert({
      type: "StructureUnderAttack",
      structureName: "Home Fortizar",
      typeName: "Fortizar",
      systemName: "Jita",
      details: { corpName: "Ceptaerin", allianceName: "Northern Coalition." },
    });
    expect(line).toContain("under attack");
    expect(line).toContain("Home Fortizar");
    expect(line).toContain("Jita");
    expect(line).toContain("Northern Coalition.");
  });

  it("falls back to the type name when the structure has no name", () => {
    const line = formatStructureAlert({
      type: "StructureDestroyed",
      structureName: null,
      typeName: "Astrahus",
      systemName: "Jita",
      details: {},
    });
    expect(line).toContain("Astrahus");
    expect(line).toContain("destroyed");
  });

  it("never exceeds the webhook clamp", () => {
    const line = formatStructureAlert({
      type: "StructureUnderAttack",
      structureName: "x".repeat(5000),
      typeName: "Fortizar",
      systemName: "Jita",
      details: {},
    });
    expect(line.length).toBeLessThanOrEqual(1900);
  });
});

describe("compareRosterRows", () => {
  it("sorts reinforced above vulnerable above healthy", () => {
    const rows = [
      { state: "shield_vulnerable", name: "b" },
      { state: "online", name: "a" },
      { state: "hull_reinforce", name: "c" },
      { state: "armor_reinforce", name: "d" },
    ];
    expect([...rows].sort(compareRosterRows).map((r) => r.state)).toEqual([
      "hull_reinforce",
      "armor_reinforce",
      "shield_vulnerable",
      "online",
    ]);
  });

  it("breaks ties by name so the order is stable across runs", () => {
    const rows = [
      { state: "online", name: "zeta" },
      { state: "online", name: "alpha" },
    ];
    expect([...rows].sort(compareRosterRows).map((r) => r.name)).toEqual([
      "alpha",
      "zeta",
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/structure-event.test.ts`
Expected: FAIL — cannot resolve `@/core/structure-event`.

- [ ] **Step 3: Write the implementation**

Create `src/core/structure-event.ts`:

```ts
/**
 * Pure parsing, formatting and ordering for structure damage notifications.
 * No I/O, no imports from services or db — this module is unit-tested on
 * literal notification bodies.
 */

/**
 * The four damage types. Fuel, low-power, anchoring and ownership-transfer
 * notifications exist and are deliberately not here: this feature alerts on
 * damage. Adding one later is a one-line change to this array.
 */
export const STRUCTURE_EVENT_TYPES = [
  "StructureUnderAttack",
  "StructureLostShields",
  "StructureLostArmor",
  "StructureDestroyed",
] as const;

export type StructureEventType = (typeof STRUCTURE_EVENT_TYPES)[number];

export function isStructureEventType(type: string): type is StructureEventType {
  return (STRUCTURE_EVENT_TYPES as readonly string[]).includes(type);
}

const SCALAR_LINE = /^([A-Za-z_][A-Za-z0-9_]*):[ \t]*(.*)$/;
const ANCHOR = /^&(\S+)[ \t]+(.*)$/;
const ALIAS = /^\*(\S+)$/;

/**
 * A tolerant reader for EVE notification bodies.
 *
 * The bodies are YAML, but a narrow dialect: top-level scalars plus block
 * sequences, with anchors used to avoid repeating a structure id. Rather than
 * take a YAML dependency for that, this reads the scalars and ignores
 * everything else.
 *
 * Three behaviours are load-bearing:
 *   - block sequence items (`- showinfo`) are skipped, not parsed as keys
 *   - `structureID: &id001 102920` yields "102920", not "&id001 102920"
 *   - `b: *id001` resolves to whatever `&id001` was bound to
 *
 * Never throws. An unparseable body yields `{}`, and the caller records the
 * event without a structure name rather than dropping the alert.
 */
export function parseNotificationBody(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const anchors: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    // Block sequence item, or a continuation of one. Not a key.
    if (/^[ \t]*-/.test(line)) continue;
    const m = SCALAR_LINE.exec(line);
    if (!m) continue;
    const [, key, rawValue] = m;
    const value = rawValue.trim();
    // A key with an empty value opens a nested block (e.g. structureShowInfoData).
    // Nothing this feature reads is nested, so drop it rather than record "".
    if (value === "") continue;
    const anchored = ANCHOR.exec(value);
    if (anchored) {
      const [, name, actual] = anchored;
      anchors[name] = actual.trim();
      out[key] = actual.trim();
      continue;
    }
    const alias = ALIAS.exec(value);
    if (alias) {
      const resolved = anchors[alias[1]];
      if (resolved !== undefined) out[key] = resolved;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** The body keys worth persisting. Everything else is dropped on the floor. */
const KEPT_KEYS = [
  "corpName",
  "allianceName",
  "charID",
  "shieldPercentage",
  "armorPercentage",
  "hullPercentage",
  "timeLeft",
  "solarsystemID",
  "structureTypeID",
  "ownerCorpName",
  "isAbandoned",
] as const;

export type ParsedStructureEvent = {
  structureId: number | null;
  details: Record<string, string | number | null>;
};

function asNumberIfNumeric(value: string): string | number {
  if (value === "") return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

/**
 * The parsed subset this feature persists and renders. Anything not in
 * KEPT_KEYS never reaches Postgres — the notifications endpoint returns every
 * notification type for the character, including personal ones.
 */
export function extractStructureEvent(text: string): ParsedStructureEvent {
  const body = parseNotificationBody(text);
  const rawId = body.structureID;
  const parsedId = rawId === undefined ? Number.NaN : Number(rawId);
  const details: Record<string, string | number | null> = {};
  for (const key of KEPT_KEYS) {
    const value = body[key];
    if (value !== undefined) details[key] = asNumberIfNumeric(value);
  }
  return {
    structureId: Number.isSafeInteger(parsedId) && parsedId > 0 ? parsedId : null,
    details,
  };
}

const VERB: Record<string, string> = {
  StructureUnderAttack: "is under attack",
  StructureLostShields: "lost shields",
  StructureLostArmor: "lost armor",
  StructureDestroyed: "was destroyed",
};

export type StructureAlertInput = {
  type: string;
  structureName: string | null;
  typeName: string | null;
  systemName: string | null;
  details: Record<string, string | number | null>;
};

/**
 * One plain-text line per alert.
 *
 * Clamped to 1900 characters here as well as in the webhook poster. The poster
 * clamps to protect Discord; this clamps so the string a test asserts on is the
 * string that gets sent, rather than one silently truncated a layer later.
 */
export function formatStructureAlert(input: StructureAlertInput): string {
  const subject = input.structureName ?? input.typeName ?? "A structure";
  const verb = VERB[input.type] ?? input.type;
  const where = input.systemName ? ` in ${input.systemName}` : "";
  const attacker =
    input.details.allianceName ?? input.details.corpName ?? null;
  const by = attacker ? ` — ${attacker}` : "";
  return `${subject}${where} ${verb}${by}`.slice(0, 1900);
}

/**
 * Most alarming first. Hull reinforce is the last timer before the structure
 * dies, so it outranks armor; both outrank a vulnerability window that nobody
 * has shot yet.
 */
const STATE_RANK: Record<string, number> = {
  hull_reinforce: 0,
  armor_reinforce: 1,
  hull_vulnerable: 2,
  armor_vulnerable: 3,
  shield_vulnerable: 4,
};

export type RosterSortable = { state: string; name: string | null };

export function compareRosterRows(a: RosterSortable, b: RosterSortable): number {
  const ra = STATE_RANK[a.state] ?? 90;
  const rb = STATE_RANK[b.state] ?? 90;
  if (ra !== rb) return ra - rb;
  // Ties break by name so the table does not reshuffle between renders on
  // rows the state cannot distinguish.
  return (a.name ?? "").localeCompare(b.name ?? "");
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/structure-event.test.ts`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
npm run format:check
git add src/core/structure-event.ts tests/structure-event.test.ts
git commit -m "feat(structures): pure notification parsing and alert formatting"
```

---

### Task 3: Extract the existing page walk into a shared helper

This task is a **pure refactor with no behaviour change**. `getAllContacts`
already reads `x-pages`, fails closed on a missing or non-integer header, and
loops pages 2..N (`src/lib/esi/client.ts:320-358`), covered by
`tests/esi-client.test.ts:109-163`. Task 4 needs the same walk for a different
endpoint, so it is extracted first, on its own, where a reviewer can reject the
refactor without rejecting the feature.

**Files:**

- Modify: `src/lib/esi/client.ts:320-358`
- Test: `tests/esi-client.test.ts` (extend)

**Interfaces:**

- Consumes: the existing `request` and `safeParse` closures inside `createEsiClient`.
- Produces: an internal `fetchAllPages<T>(path: (page: number) => string, schema: z.ZodType<T[]>, accessToken: string, opts?: { base?: string; compatibilityDate?: boolean }): Promise<T[]>`.

- [ ] **Step 1: Record the behaviour this refactor must preserve**

This task writes no new test. Its proof is that the existing contacts
pagination coverage (`tests/esi-client.test.ts:109-163`) stays green across the
extraction — that is what "behaviour-preserving" means here, and a new test
would only assert the new helper's shape rather than the old behaviour.

The fail-closed test for the roster endpoint belongs to Task 4, which is where
`getCorporationStructures` comes into existence. Do not write it here: `npm test`
is a CI gate on every commit, so a knowingly-red suite at this commit would make
any later bisect through this range meaningless.

- [ ] **Step 2: Run the existing pagination tests to record the baseline**

Run: `npx vitest run tests/esi-client.test.ts -t "pages"`
Expected: PASS. Note the count; it must be identical after step 3.

- [ ] **Step 3: Extract the helper**

Inside `createEsiClient`, add before `getAllContacts`:

```ts
  /**
   * Reads every page of a paginated ESI collection.
   *
   * Fails closed on a missing or non-integer `x-pages`: an unknown page count
   * means an unknown result set, and both callers feed a diff that REMOVES
   * (contacts deletes; the structure roster stamps missingSince). Never guess
   * — spec: never remove on unknown state.
   *
   * Extracted from getAllContacts, whose behaviour it preserves exactly.
   */
  async function fetchAllPages<T>(
    pathFor: (page: number) => string,
    schema: z.ZodType<T[]>,
    accessToken: string,
    opts: { base?: string; compatibilityDate?: boolean } = {},
  ): Promise<T[]> {
    const first = await request(pathFor(1), { accessToken, ...opts });
    const pagesHeader = first.headers.get("x-pages");
    const pages = Number(pagesHeader);
    if (pagesHeader === null || !Number.isInteger(pages) || pages < 1) {
      throw new EsiError(
        `ESI GET ${pathFor(1)}: missing or invalid X-Pages header (${pagesHeader})`,
        0,
        "transient",
      );
    }
    const out = safeParse(
      schema,
      await first.json(),
      "GET",
      pathFor(1),
      first.status,
    ).slice();
    for (let page = 2; page <= pages; page++) {
      const res = await request(pathFor(page), { accessToken, ...opts });
      out.push(...safeParse(schema, await res.json(), "GET", pathFor(page), res.status));
    }
    return out;
  }
```

Then rewrite `getAllContacts`'s body to use it, keeping its public signature,
its doc comment, and its final `.map(...)` shape unchanged:

```ts
  /** Reads ALL pages; any page failure rejects the whole call. */
  async function getAllContacts(
    characterId: number,
    accessToken: string,
  ): Promise<EsiContact[]> {
    const raw = await fetchAllPages(
      (page) => `/characters/${characterId}/contacts/?page=${page}`,
      contactsSchema,
      accessToken,
    );
    return raw.map((c) => ({
      contactId: c.contact_id,
      // ...unchanged: copy the existing mapping verbatim
    }));
  }
```

- [ ] **Step 4: Prove the refactor changed nothing**

Run: `npx vitest run tests/esi-client.test.ts -t "pages"`
Expected: PASS, same count as step 2. If any contacts pagination assertion
changed, the extraction was not behaviour-preserving — revert and redo.

- [ ] **Step 5: Format and commit**

```bash
npm run format:check
git add src/lib/esi/client.ts
git commit -m "refactor(esi): extract the paged-collection walk from getAllContacts"
```

---

### Task 4: ESI scopes and the two new reads

**Files:**

- Modify: `src/lib/esi/client.ts`
- Test: `tests/esi-client.test.ts` (extend)

**Interfaces:**

- Consumes: `fetchAllPages` from Task 3.
- Produces:
  - `STRUCTURES_SCOPE = "esi-corporations.read_structures.v1"`
  - `NOTIFICATIONS_SCOPE = "esi-characters.read_notifications.v1"`
  - `type EsiCorporationStructure = { structureId: number; typeId: number; systemId: number; name: string | null; state: string; stateTimerStart: Date | null; stateTimerEnd: Date | null; fuelExpires: Date | null }`
  - `type EsiNotification = { notificationId: number; type: string; timestamp: Date; text: string }`
  - `getCorporationStructures(corporationId: number, accessToken: string): Promise<EsiCorporationStructure[]>`
  - `getCharacterNotifications(characterId: number, accessToken: string): Promise<EsiNotification[]>`
  - `type StructuresEsi = Pick<EsiClient, "getCorporationStructures" | "getUniverseNames">`
  - `type StructureEventsEsi = Pick<EsiClient, "getCharacterNotifications">`

- [ ] **Step 1: Write the failing test**

Append to `tests/esi-client.test.ts`:

```ts
describe("paged reads fail closed", () => {
  it("rejects a corporation structures read with no X-Pages header", async () => {
    server.use(
      http.get(`${ROOT}/corporations/98000001/structures/`, () =>
        HttpResponse.json([], { headers: {} }),
      ),
    );
    const esi = createEsiClient();
    await expect(esi.getCorporationStructures(98000001, "tok")).rejects.toThrow(
      /X-Pages/i,
    );
  });
});

describe("getCorporationStructures", () => {
  it("reads every page and maps timestamps to Date", async () => {
    server.use(
      http.get(`${ROOT}/corporations/98000001/structures/`, ({ request: req }) => {
        const page = new URL(req.url).searchParams.get("page");
        const body =
          page === "1"
            ? [
                {
                  structure_id: 1029209158734,
                  type_id: 35832,
                  system_id: 30004268,
                  name: "Home Fortizar",
                  state: "armor_reinforce",
                  state_timer_end: "2026-08-25T12:00:00Z",
                  fuel_expires: "2026-09-01T00:00:00Z",
                },
              ]
            : [
                {
                  structure_id: 2,
                  type_id: 35832,
                  system_id: 30004268,
                  state: "shield_vulnerable",
                },
              ];
        return HttpResponse.json(body, { headers: { "x-pages": "2" } });
      }),
    );
    const esi = createEsiClient();
    const rows = await esi.getCorporationStructures(98000001, "tok");
    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe("Home Fortizar");
    expect(rows[0].stateTimerEnd).toBeInstanceOf(Date);
    expect(rows[1].name).toBeNull();
    expect(rows[1].fuelExpires).toBeNull();
  });
});

describe("getCharacterNotifications", () => {
  it("returns id, type, timestamp and raw text", async () => {
    server.use(
      http.get(`${ROOT}/characters/90000001/notifications/`, () =>
        HttpResponse.json([
          {
            notification_id: 123456,
            type: "StructureUnderAttack",
            sender_id: 98000001,
            sender_type: "corporation",
            timestamp: "2026-08-24T10:00:00Z",
            text: "structureID: &id001 1029209158734",
          },
        ]),
      ),
    );
    const esi = createEsiClient();
    const rows = await esi.getCharacterNotifications(90000001, "tok");
    expect(rows).toHaveLength(1);
    expect(rows[0].notificationId).toBe(123456);
    expect(rows[0].type).toBe("StructureUnderAttack");
    expect(rows[0].timestamp).toBeInstanceOf(Date);
    expect(rows[0].text).toContain("structureID");
  });

  it("tolerates a notification with no text body", async () => {
    server.use(
      http.get(`${ROOT}/characters/90000001/notifications/`, () =>
        HttpResponse.json([
          {
            notification_id: 7,
            type: "StructureDestroyed",
            sender_id: 1,
            sender_type: "corporation",
            timestamp: "2026-08-24T10:00:00Z",
          },
        ]),
      ),
    );
    const esi = createEsiClient();
    expect((await esi.getCharacterNotifications(90000001, "tok"))[0].text).toBe("");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/esi-client.test.ts -t "Structures"`
Expected: FAIL — `esi.getCorporationStructures is not a function`.

- [ ] **Step 3: Add the scope constants**

Beside `ACCESS_LISTS_SCOPE` in `src/lib/esi/client.ts`:

```ts
/**
 * Deliberately NOT in EVE_SSO_SCOPES, for the reason ACCESS_LISTS_SCOPE gives:
 * adding either there would flip every character to needs_reauth at the next
 * token-health run, for a feature only one character needs.
 *
 * Note the corporations scope is NOT `esi-universe.read_structures.v1`, which
 * IS already in EVE_SSO_SCOPES and resolves a single structure's NAME for the
 * location job. The two differ by one word and grant different things.
 *
 * Both also require an in-game corp role that no scope can grant:
 * Station_Manager for the roster, and Director or CEO for corp structure
 * notifications to be delivered to the character at all.
 */
export const STRUCTURES_SCOPE = "esi-corporations.read_structures.v1";
export const NOTIFICATIONS_SCOPE = "esi-characters.read_notifications.v1";
```

- [ ] **Step 4: Add the schemas, mappers and methods**

Beside the other zod schemas:

```ts
const corporationStructuresSchema = z.array(
  z.object({
    structure_id: z.number(),
    type_id: z.number().int(),
    system_id: z.number().int(),
    name: z.string().optional(),
    state: z.string(),
    state_timer_start: z.string().optional(),
    state_timer_end: z.string().optional(),
    fuel_expires: z.string().optional(),
  }),
);

const notificationsSchema = z.array(
  z.object({
    notification_id: z.number(),
    type: z.string(),
    timestamp: z.string(),
    // Absent on some notification types. Never fail a read over a missing body:
    // the event still happened and still deserves an alert.
    text: z.string().optional(),
  }),
);
```

Exported types, beside `EsiAccessList`:

```ts
export type EsiCorporationStructure = {
  structureId: number;
  typeId: number;
  systemId: number;
  name: string | null;
  state: string;
  stateTimerStart: Date | null;
  stateTimerEnd: Date | null;
  fuelExpires: Date | null;
};

export type EsiNotification = {
  notificationId: number;
  type: string;
  timestamp: Date;
  text: string;
};
```

Methods inside `createEsiClient`, beside `getAccessLists`:

```ts
  function optionalDate(value: string | undefined): Date | null {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  /**
   * Every structure the corporation owns. Paginated, and read through
   * fetchAllPages so a missing X-Pages fails closed rather than truncating —
   * the roster's missingSince stamping is a diff that removes.
   *
   * A 403 here means the character lacks the Station_Manager corp role. It
   * classifies `permanent` (core/errors.ts: 403 is needs_reauth only when the
   * body names a scope/token/authorization problem, and the role error does
   * not), which is what lets the caller tell it apart from a token fault.
   * Nothing is swallowed here; the caller classifies.
   */
  async function getCorporationStructures(
    corporationId: number,
    accessToken: string,
  ): Promise<EsiCorporationStructure[]> {
    const raw = await fetchAllPages(
      (page) => `/corporations/${corporationId}/structures/?page=${page}`,
      corporationStructuresSchema,
      accessToken,
      { base: ESI_ROOT, compatibilityDate: true },
    );
    return raw.map((s) => ({
      structureId: s.structure_id,
      typeId: s.type_id,
      systemId: s.system_id,
      name: s.name ?? null,
      state: s.state,
      stateTimerStart: optionalDate(s.state_timer_start),
      stateTimerEnd: optionalDate(s.state_timer_end),
      fuelExpires: optionalDate(s.fuel_expires),
    }));
  }

  /**
   * The character's notifications — ALL types, not only structure ones. The
   * caller filters; this client does not, because filtering here would hide
   * from the test suite what the endpoint actually returns.
   *
   * Not paginated: ESI returns a single page of the most recent ~50 from the
   * last 90 days.
   */
  async function getCharacterNotifications(
    characterId: number,
    accessToken: string,
  ): Promise<EsiNotification[]> {
    const path = `/characters/${characterId}/notifications/`;
    const res = await request(path, {
      accessToken,
      base: ESI_ROOT,
      compatibilityDate: true,
    });
    const raw = safeParse(notificationsSchema, await res.json(), "GET", path, res.status);
    return raw.map((n) => ({
      notificationId: n.notification_id,
      type: n.type,
      timestamp: new Date(n.timestamp),
      text: n.text ?? "",
    }));
  }
```

Add both to the object `createEsiClient` returns, then add the narrowed types
beside `AccessListsEsi`:

```ts
/** The roster job's narrow view: reads only, no writes reachable. */
export type StructuresEsi = Pick<
  EsiClient,
  "getCorporationStructures" | "getUniverseNames"
>;
/** The events job's narrow view. */
export type StructureEventsEsi = Pick<EsiClient, "getCharacterNotifications">;
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/esi-client.test.ts`
Expected: PASS, including the fail-closed test written in Task 3 step 1.

- [ ] **Step 6: Format and commit**

```bash
npm run format:check
git add src/lib/esi/client.ts tests/esi-client.test.ts
git commit -m "feat(esi): corporation structures and character notifications reads"
```

---

### Task 5: Config and webhook resolution

**Files:**

- Modify: `src/config.ts`
- Modify: `src/lib/ops-webhook.ts`
- Modify: `.env.example`
- Test: `tests/config.test.ts` (extend), `tests/ops-webhook.test.ts` (extend or create)

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `cfg.discord.structureWebhookUrl: string | undefined`
  - `resolveStructureWebhookUrl(cfg: Config): string | undefined`
  - `postStructureWebhook(cfg: Config, content: string, fetchImpl?: typeof fetch): Promise<void>`
  - `postOpsWebhookOrThrow(cfg, content, fetchImpl?)` gains an internal url parameter but keeps its exported signature.

**Why this task is separate:** `postOpsWebhookOrThrow` returns early and
*successfully* when no URL is configured (`src/lib/ops-webhook.ts:47-48`).
That is correct for its existing callers and wrong for this feature, where a
successful no-op would mark an owed alert `sent`. The resolution has to be
readable *before* a post is attempted, by both the job and the page.

- [ ] **Step 1: Write the failing test**

Create `tests/structure-webhook.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { postStructureWebhook, resolveStructureWebhookUrl } from "@/lib/ops-webhook";
import { testConfig } from "./helpers/config";

function cfgWith(over: { structure?: string; ops?: string }) {
  const base = testConfig();
  return {
    ...base,
    syncMode: "live" as const,
    discord: {
      ...base.discord,
      structureWebhookUrl: over.structure,
      opsWebhookUrl: over.ops,
    },
  };
}

describe("resolveStructureWebhookUrl", () => {
  it("prefers the structure webhook", () => {
    expect(
      resolveStructureWebhookUrl(
        cfgWith({ structure: "https://s.example", ops: "https://o.example" }),
      ),
    ).toBe("https://s.example");
  });

  it("falls back to the ops webhook", () => {
    expect(resolveStructureWebhookUrl(cfgWith({ ops: "https://o.example" }))).toBe(
      "https://o.example",
    );
  });

  it("is undefined when neither is set", () => {
    expect(resolveStructureWebhookUrl(cfgWith({}))).toBeUndefined();
  });
});

describe("postStructureWebhook", () => {
  it("throws when no webhook is configured, rather than silently succeeding", async () => {
    const fetchImpl = vi.fn();
    await expect(
      postStructureWebhook(cfgWith({}), "boom", fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/not configured/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts to the resolved url", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await postStructureWebhook(
      cfgWith({ structure: "https://s.example" }),
      "hello",
      fetchImpl as unknown as typeof fetch,
    );
    expect(fetchImpl.mock.calls[0][0]).toBe("https://s.example");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/structure-webhook.test.ts`
Expected: FAIL — `resolveStructureWebhookUrl` is not exported.

- [ ] **Step 3: Add the env var**

In `src/config.ts`, beside `DISCORD_OPS_WEBHOOK_URL` in `envSchema`:

```ts
  DISCORD_STRUCTURE_WEBHOOK_URL: z.string().url().optional().or(z.literal("")),
```

and in the `discord` block of the returned config, beside `opsWebhookUrl`:

```ts
      structureWebhookUrl: e.DISCORD_STRUCTURE_WEBHOOK_URL || undefined,
```

In `.env.example`, beside `DISCORD_OPS_WEBHOOK_URL=`:

```
# Optional. Structure damage alerts. Falls back to DISCORD_OPS_WEBHOOK_URL when
# unset; when NEITHER is set, nothing is alerted and /admin/structures says so.
DISCORD_STRUCTURE_WEBHOOK_URL=
```

- [ ] **Step 4: Give the poster an explicit url and add the structure variants**

In `src/lib/ops-webhook.ts`, change `postOpsWebhookOrThrow` to take the url from
a parameter with the existing config read as its default, so no existing caller
changes:

```ts
export async function postOpsWebhookOrThrow(
  cfg: Config,
  content: string,
  fetchImpl: typeof fetch = fetch,
  url: string | undefined = cfg.discord.opsWebhookUrl,
): Promise<void> {
  if (!url) return;
  if (isDryRun(cfg)) {
    logSuppressedWrite("ops-webhook", content.slice(0, 200));
    return;
  }
  await postOpsWebhookUrl(url, content, fetchImpl);
}
```

Then append:

```ts
/**
 * Where a structure alert goes: the dedicated webhook, else the ops one.
 *
 * Exposed rather than resolved inside the poster because both the job and the
 * page need to know the answer BEFORE anything is posted. A post's return
 * value cannot distinguish "delivered" from "nowhere to deliver" —
 * postOpsWebhookOrThrow returns successfully when no url is set — so a job that
 * inferred delivery from it would mark every owed alert `sent` on a deployment
 * with no webhook configured at all.
 */
export function resolveStructureWebhookUrl(cfg: Config): string | undefined {
  return cfg.discord.structureWebhookUrl ?? cfg.discord.opsWebhookUrl;
}

/**
 * Posts a structure alert, THROWING when there is no webhook configured.
 *
 * The throw is the point: unlike the ops alerts, a dropped structure alert is
 * the failure this whole feature exists to prevent. Callers must have checked
 * resolveStructureWebhookUrl first and recorded the event as `seeded` if it
 * returned undefined; reaching here with no url is a bug, not a configuration.
 */
export async function postStructureWebhook(
  cfg: Config,
  content: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = resolveStructureWebhookUrl(cfg);
  if (!url) throw new OpsWebhookError("structure webhook not configured");
  await postOpsWebhookOrThrow(cfg, content, fetchImpl, url);
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/structure-webhook.test.ts tests/config.test.ts tests/sync-mode.test.ts`
Expected: PASS. `tests/sync-mode.test.ts` covers the existing dry-run
suppression and must be unaffected.

- [ ] **Step 6: Format and commit**

```bash
npm run format:check
git add src/config.ts src/lib/ops-webhook.ts .env.example tests/structure-webhook.test.ts
git commit -m "feat(structures): dedicated alert webhook with explicit resolution"
```

---

### Task 6: The service layer

**Files:**

- Create: `src/services/structures.ts`
- Test: `tests/structure-service.test.ts`

**Interfaces:**

- Consumes: Task 1's tables, `logAudit` from `@/services/audit`.
- Produces:
  - `STRUCTURE_HOLDER_ROW_ID = 1`
  - `type StructureHolder = { characterId: number; corporationId: number; designatedAt: Date; designatedBy: string; seededAt: Date | null }`
  - `getStructureHolder(dbx: Dbx): Promise<StructureHolder | null>`
  - `designateStructureHolder(db: Db, characterId: number, corporationId: number, actor: string): Promise<{ abandonedAlerts: number }>`
  - `stillStructureHolder(tx: Dbx, characterId: number): Promise<boolean>`
  - `markSeeded(dbx: Dbx, at: Date): Promise<void>`
  - `recordReadState(dbx: Dbx, input: { kind: "roster" | "events"; corporationId: number; status: StructureReadStatus; detail?: string | null; observed: boolean; at: Date }): Promise<void>`
  - `getReadStates(dbx: Dbx, corporationId: number): Promise<Record<string, { observedAt: Date | null; lastAttemptAt: Date; readStatus: StructureReadStatus; detail: string | null }>>`
  - `getRoster(dbx: Dbx, corporationId: number): Promise<RosterRow[]>`
  - `getRecentEvents(dbx: Dbx, corporationId: number, limit: number): Promise<EventRow[]>`
  - `findGrantableCharacter(dbx: Dbx): Promise<{ characterId: number; name: string; corporationId: number | null } | null>` — the first admin-owned character whose PERSISTED `scopes` carry both structure scopes. Reads `character.scopes`, never `cfg.eveSso.scopes`: config says what we ask for, the column says what was granted.
  - `toHolderView(dbx: Dbx, holder: StructureHolder): Promise<HolderView>` — joins `character` to fill `name`, `scopes`, `tokenStatus` and `currentCorporationId`. **Declare `HolderView` here**, in `src/services/structures.ts`; Task 10's `view.ts` imports it. It describes a service read's return shape, and declaring it in `view.ts` would make this task depend on a later one:

```ts
export type HolderView = {
  characterId: number;
  name: string;
  scopes: string[];
  tokenStatus: "valid" | "invalid" | "needs_reauth" | "missing";
  /** The corp PINNED at designation. */
  corporationId: number;
  /** What character.corporationId says right now — null when never resolved. */
  currentCorporationId: number | null;
};
```

- [ ] **Step 1: Write the failing test**

Create `tests/structure-service.test.ts`:

```ts
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { auditLog, structureEvent } from "@/db/schema";
import {
  designateStructureHolder,
  getStructureHolder,
  markSeeded,
  stillStructureHolder,
} from "@/services/structures";

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

describe("designateStructureHolder", () => {
  it("pins the corporation and audits the designation", async () => {
    const account = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, testConfig(), { id: 90000001, accountId: account.id });
    await designateStructureHolder(ctx.db, 90000001, 98000001, account.id);

    const holder = await getStructureHolder(ctx.db);
    expect(holder).toMatchObject({ characterId: 90000001, corporationId: 98000001 });
    expect(holder?.seededAt).toBeNull();

    const rows = await ctx.db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("structure.holder_designated");
    expect(rows[0].details).toMatchObject({
      characterId: 90000001,
      corporationId: 98000001,
    });
  });

  it("retires pending alerts when the holder is replaced, and says how many", async () => {
    const account = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, testConfig(), { id: 90000001, accountId: account.id });
    await seedCharacter(ctx.db, testConfig(), { id: 90000002, accountId: account.id });
    await designateStructureHolder(ctx.db, 90000001, 98000001, account.id);
    await ctx.db.insert(structureEvent).values([
      {
        notificationId: 1,
        type: "StructureUnderAttack",
        sentAt: new Date(),
        corporationId: 98000001,
        alertStatus: "pending",
      },
      {
        notificationId: 2,
        type: "StructureLostArmor",
        sentAt: new Date(),
        corporationId: 98000001,
        alertStatus: "sent",
      },
    ]);

    const result = await designateStructureHolder(
      ctx.db,
      90000002,
      98000002,
      account.id,
    );
    expect(result.abandonedAlerts).toBe(1);

    const [one] = await ctx.db
      .select()
      .from(structureEvent)
      .where(eq(structureEvent.notificationId, 1));
    expect(one.alertStatus).toBe("abandoned");
    const [two] = await ctx.db
      .select()
      .from(structureEvent)
      .where(eq(structureEvent.notificationId, 2));
    expect(two.alertStatus).toBe("sent");

    const rows = await ctx.db.select().from(auditLog);
    const replaced = rows.find((r) => r.action === "structure.holder_replaced");
    expect(replaced?.details).toMatchObject({
      previousCharacterId: 90000001,
      characterId: 90000002,
      abandonedAlerts: 1,
    });
  });

  it("resets seededAt so a new holder re-seeds", async () => {
    const account = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, testConfig(), { id: 90000001, accountId: account.id });
    await seedCharacter(ctx.db, testConfig(), { id: 90000002, accountId: account.id });
    await designateStructureHolder(ctx.db, 90000001, 98000001, account.id);
    await markSeeded(ctx.db, new Date());
    expect((await getStructureHolder(ctx.db))?.seededAt).toBeInstanceOf(Date);
    await designateStructureHolder(ctx.db, 90000002, 98000002, account.id);
    expect((await getStructureHolder(ctx.db))?.seededAt).toBeNull();
  });
});

describe("stillStructureHolder", () => {
  it("is false once another character has been designated", async () => {
    const account = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, testConfig(), { id: 90000001, accountId: account.id });
    await seedCharacter(ctx.db, testConfig(), { id: 90000002, accountId: account.id });
    await designateStructureHolder(ctx.db, 90000001, 98000001, account.id);
    expect(await stillStructureHolder(ctx.db, 90000001)).toBe(true);
    await designateStructureHolder(ctx.db, 90000002, 98000002, account.id);
    expect(await stillStructureHolder(ctx.db, 90000001)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/structure-service.test.ts`
Expected: FAIL — cannot resolve `@/services/structures`.

- [ ] **Step 3: Write the service**

Create `src/services/structures.ts`:

```ts
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db, Dbx } from "@/db";
import {
  structure,
  structureEvent,
  structureHolder,
  structureReadState,
  type StructureReadStatus,
} from "@/db/schema";
import { logAudit } from "@/services/audit";

/**
 * The holder table is a singleton enforced by `CHECK (id = 1)`. One constant so
 * every read and write spells the key the same way; a literal `1` scattered
 * across call sites is how a second row eventually appears.
 */
export const STRUCTURE_HOLDER_ROW_ID = 1;

export type StructureHolder = {
  characterId: number;
  corporationId: number;
  designatedAt: Date;
  designatedBy: string;
  seededAt: Date | null;
};

export async function getStructureHolder(dbx: Dbx): Promise<StructureHolder | null> {
  const [row] = await dbx
    .select({
      characterId: structureHolder.characterId,
      corporationId: structureHolder.corporationId,
      designatedAt: structureHolder.designatedAt,
      designatedBy: structureHolder.designatedBy,
      seededAt: structureHolder.seededAt,
    })
    .from(structureHolder)
    .where(eq(structureHolder.id, STRUCTURE_HOLDER_ROW_ID));
  return row ?? null;
}

/**
 * Points the monitor at a character and PINS the corporation, in one
 * transaction so the audit row, the designation and the retired alerts cannot
 * disagree.
 *
 * Three things happen together and must not be separable:
 *   1. the designation is written, with `seededAt` reset to null so the new
 *      holder re-seeds rather than replaying a 90-day backlog;
 *   2. every `pending` alert is retired to `abandoned` — those were owed to a
 *      holder that no longer exists, and posting them under the new one would
 *      alert about a corp this monitor no longer watches;
 *   3. the audit row records how many were retired, which is the only number
 *      that says whether a holder swap swallowed a live attack.
 */
export async function designateStructureHolder(
  db: Db,
  characterId: number,
  corporationId: number,
  actor: string,
): Promise<{ abandonedAlerts: number }> {
  return db.transaction(async (tx) => {
    const previous = await getStructureHolder(tx);
    const designatedAt = new Date();
    await tx
      .insert(structureHolder)
      .values({
        id: STRUCTURE_HOLDER_ROW_ID,
        characterId,
        corporationId,
        designatedAt,
        designatedBy: actor,
        seededAt: null,
      })
      .onConflictDoUpdate({
        target: structureHolder.id,
        set: { characterId, corporationId, designatedAt, designatedBy: actor, seededAt: null },
      });

    const retired = previous
      ? await tx
          .update(structureEvent)
          .set({ alertStatus: "abandoned" })
          .where(eq(structureEvent.alertStatus, "pending"))
          .returning({ id: structureEvent.notificationId })
      : [];

    await logAudit(tx, {
      actor,
      action: previous ? "structure.holder_replaced" : "structure.holder_designated",
      target: String(characterId),
      details: previous
        ? {
            previousCharacterId: previous.characterId,
            characterId,
            corporationId,
            abandonedAlerts: retired.length,
          }
        : { characterId, corporationId },
    });
    return { abandonedAlerts: retired.length };
  });
}

/**
 * Whether `characterId` is STILL the designated holder, read inside the
 * caller's transaction. A job that read the holder minutes ago must not write
 * another character's data under this designation; every write CASes on this.
 */
export async function stillStructureHolder(
  tx: Dbx,
  characterId: number,
): Promise<boolean> {
  const holder = await getStructureHolder(tx);
  return holder?.characterId === characterId;
}

/** Stamps the first completed poll, which is what switches seeding off. */
export async function markSeeded(dbx: Dbx, at: Date): Promise<void> {
  await dbx
    .update(structureHolder)
    .set({ seededAt: at })
    .where(eq(structureHolder.id, STRUCTURE_HOLDER_ROW_ID));
}

/**
 * Records one read attempt. `observedAt` advances ONLY on success, so the page
 * can say how stale a roster is without either lying about freshness or
 * discarding the failure that made it stale.
 */
export async function recordReadState(
  dbx: Dbx,
  input: {
    kind: "roster" | "events";
    corporationId: number;
    status: StructureReadStatus;
    detail?: string | null;
    observed: boolean;
    at: Date;
  },
): Promise<void> {
  const set: Record<string, unknown> = {
    lastAttemptAt: input.at,
    readStatus: input.status,
    detail: input.detail ?? null,
  };
  if (input.observed) set.observedAt = input.at;
  await dbx
    .insert(structureReadState)
    .values({
      kind: input.kind,
      corporationId: input.corporationId,
      observedAt: input.observed ? input.at : null,
      lastAttemptAt: input.at,
      readStatus: input.status,
      detail: input.detail ?? null,
    })
    .onConflictDoUpdate({
      target: [structureReadState.kind, structureReadState.corporationId],
      set,
    });
}

export type ReadStateRow = {
  observedAt: Date | null;
  lastAttemptAt: Date;
  readStatus: StructureReadStatus;
  detail: string | null;
};

export async function getReadStates(
  dbx: Dbx,
  corporationId: number,
): Promise<Record<string, ReadStateRow>> {
  const rows = await dbx
    .select()
    .from(structureReadState)
    .where(eq(structureReadState.corporationId, corporationId));
  const out: Record<string, ReadStateRow> = {};
  for (const r of rows) {
    out[r.kind] = {
      observedAt: r.observedAt,
      lastAttemptAt: r.lastAttemptAt,
      readStatus: r.readStatus,
      detail: r.detail,
    };
  }
  return out;
}

export type RosterRow = {
  structureId: number;
  name: string | null;
  typeName: string | null;
  systemId: number;
  state: string;
  stateTimerEnd: Date | null;
  fuelExpires: Date | null;
  observedAt: Date;
  missingSince: Date | null;
};

export async function getRoster(
  dbx: Dbx,
  corporationId: number,
): Promise<RosterRow[]> {
  return dbx
    .select({
      structureId: structure.structureId,
      name: structure.name,
      typeName: structure.typeName,
      systemId: structure.systemId,
      state: structure.state,
      stateTimerEnd: structure.stateTimerEnd,
      fuelExpires: structure.fuelExpires,
      observedAt: structure.observedAt,
      missingSince: structure.missingSince,
    })
    .from(structure)
    .where(eq(structure.corporationId, corporationId));
}

export type EventRow = {
  notificationId: number;
  type: string;
  sentAt: Date;
  structureId: number | null;
  details: Record<string, string | number | null> | null;
};

export async function getRecentEvents(
  dbx: Dbx,
  corporationId: number,
  limit: number,
): Promise<EventRow[]> {
  return dbx
    .select({
      notificationId: structureEvent.notificationId,
      type: structureEvent.type,
      sentAt: structureEvent.sentAt,
      structureId: structureEvent.structureId,
      details: structureEvent.details,
    })
    .from(structureEvent)
    .where(eq(structureEvent.corporationId, corporationId))
    .orderBy(desc(structureEvent.sentAt))
    .limit(limit);
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/structure-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
npm run format:check
git add src/services/structures.ts tests/structure-service.test.ts
git commit -m "feat(structures): holder designation, read state and roster reads"
```

---

### Task 7: Audit vocabulary and the opt-in grant

Small, but it gates Task 11's page: the designate action cannot audit until the
namespace is registered, and the page's re-grant link cannot work until the
route knows the grant name.

**Files:**

- Modify: `src/services/audit.ts` (`NAMESPACE_TARGET_KIND`, `DETAIL_CHARACTER_KEYS`)
- Modify: `src/app/admin/audit/summarize.ts`
- Modify: `src/app/auth/eve/link/route.ts`
- Test: `tests/audit-summarize.test.ts` (extend), `tests/auth-routes.test.ts` (extend)

**Interfaces:**

- Consumes: `STRUCTURES_SCOPE`, `NOTIFICATIONS_SCOPE` from Task 4.
- Produces: `?grant=structures` on `/auth/eve/link`; audit rendering for the two `structure.*` actions.

**Note:** the symbol is `NAMESPACE_TARGET_KIND` (`src/services/audit.ts:214`).
The spec calls it `TARGET_KIND_BY_NAMESPACE`; the spec is wrong on the name.

- [ ] **Step 1: Write the failing test**

Append to `tests/auth-routes.test.ts`:

```ts
it("adds both structure scopes for grant=structures, and nothing else", async () => {
  const res = await GET(linkRequest("/auth/eve/link?grant=structures"));
  const scope = new URL(res.headers.get("location")!).searchParams.get("scope")!;
  expect(scope).toContain("esi-corporations.read_structures.v1");
  expect(scope).toContain("esi-characters.read_notifications.v1");
  expect(scope).not.toContain("esi-access.read_lists.v1");
});

it("ignores an unknown grant value", async () => {
  const res = await GET(linkRequest("/auth/eve/link?grant=esi-corporations.read_blueprints.v1"));
  const scope = new URL(res.headers.get("location")!).searchParams.get("scope")!;
  expect(scope).not.toContain("blueprints");
});

// A prototype-chain key must take the same path as an unknown key, not throw.
// Assert on the resulting scope SET, not merely that nothing threw: a
// no-throw assertion would still pass if the route silently began granting
// something.
it("treats a prototype-chain grant key as unknown", async () => {
  for (const grant of ["toString", "constructor", "__proto__"]) {
    const res = await GET(linkRequest(`/auth/eve/link?grant=${encodeURIComponent(grant)}`));
    expect(res.status).toBe(307);
    const scope = new URL(res.headers.get("location")!).searchParams.get("scope")!;
    expect(scope.split(" ")).not.toContain(ACCESS_LISTS_SCOPE);
  }
});
```

Use whatever request helper the existing tests in that file already use for
`/auth/eve/link`; do not invent a new one.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/auth-routes.test.ts -t "structure"`
Expected: FAIL — the scope is absent from the authorize URL.

- [ ] **Step 3: Extend the link route**

In `src/app/auth/eve/link/route.ts`, replace the single-grant expression with a
lookup table, keeping the existing comment's argument intact:

```ts
import {
  ACCESS_LISTS_SCOPE,
  NOTIFICATIONS_SCOPE,
  STRUCTURES_SCOPE,
} from "@/lib/esi/client";

// Opt-in only: none of these are in EVE_SSO_SCOPES, because adding one there
// would flip every character to needs_reauth at the next token-health run.
// Exact literals keyed by an allowed grant name, never a free-form scope
// parameter — the query string is attacker-controllable and must not be able
// to widen what we ask EVE for.
const GRANTS: Record<string, readonly string[]> = {
  "access-lists": [ACCESS_LISTS_SCOPE],
  structures: [STRUCTURES_SCOPE, NOTIFICATIONS_SCOPE],
};

// `Object.hasOwn`, NOT a bare index and NOT `in`. `GRANTS` is a plain object
// literal, so it inherits from `Object.prototype`: a bare `GRANTS[grant]`
// returns an inherited member for `grant=toString`, `constructor` or
// `__proto__`, which `?? []` does not catch and the spread then throws —
// an unhandled 500 on a crafted query string. `in` walks the prototype chain
// too and would not fix it. Same guard `isJobType` uses (src/core/schedules.ts:40).
const grant = req.nextUrl.searchParams.get("grant") ?? "";
const extraScopes = Object.hasOwn(GRANTS, grant) ? [...GRANTS[grant]] : [];
```

- [ ] **Step 4: Register the audit vocabulary**

In `src/services/audit.ts`, add to `NAMESPACE_TARGET_KIND`:

```ts
  "structure.": "character",
```

and to `DETAIL_CHARACTER_KEYS`:

```ts
  "structure.holder_designated": ["characterId"],
  "structure.holder_replaced": ["characterId", "previousCharacterId"],
```

In `src/app/admin/audit/summarize.ts`, add entries beside the `access_list.*`
ones, following the existing `Part` combinator style:

```ts
  "structure.holder_designated": (d) => [characterRef(d, "characterId")],
  "structure.holder_replaced": (d) => [
    transition(characterRef(d, "previousCharacterId"), characterRef(d, "characterId")),
    labelled("abandoned alerts", scalar(d.abandonedAlerts)),
  ],
```

Match the exact combinator signatures already in that file — read them before
writing this, and adapt if they differ.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/auth-routes.test.ts tests/audit-summarize.test.ts tests/audit.test.ts`
Expected: PASS.

- [ ] **Step 6: Format and commit**

```bash
npm run format:check
git add src/app/auth/eve/link/route.ts src/services/audit.ts src/app/admin/audit/summarize.ts tests/auth-routes.test.ts
git commit -m "feat(structures): opt-in scope grant and audit vocabulary"
```

---

### Task 8: The roster job

**Files:**

- Create: `src/jobs/structures.ts`
- Modify: `src/core/schedules.ts` (`JOB_CRON`, `JOB_GROUP`)
- Modify: `src/worker/queues.ts` (`QUEUES`, `JOB_QUEUES`)
- Modify: `src/worker/handlers.ts`
- Modify: `src/services/sync-status.ts` (`KNOWN_ORDER`)
- Test: `tests/structure-roster-job.test.ts`, plus expectations in `tests/schedules.test.ts`, `tests/worker-queues.test.ts`, `tests/dispatcher.test.ts`

**Interfaces:**

- Consumes: `StructuresEsi` (Task 4), the service (Task 6), `compareRosterRows` (Task 2).
- Produces: `runStructuresJob(deps: { db: Db; cfg: Config; esi: StructuresEsi; fetchImpl?: typeof fetch }): Promise<JobResult>`.

- [ ] **Step 1: Write the failing test**

Create `tests/structure-roster-job.test.ts`. Follow
`tests/access-lists-job.test.ts` exactly for setup: real Postgres via
`setupTestDb`, `truncateAll` per test, `testConfig()`, `seedAccount` /
`seedCharacter`, a hand-rolled `StructuresEsi` fake, and `okToken` /
`deadToken` / `flakyToken` `fetchImpl` stubs. Copy those helpers from that file
rather than importing them.

```ts
const CORP = 98000001;
const HOLDER = 90000001;

function fakeEsi(opts: {
  structures?: EsiCorporationStructure[];
  error?: Error;
}): StructuresEsi {
  return {
    getCorporationStructures: async () => {
      if (opts.error) throw opts.error;
      return opts.structures ?? [];
    },
    getUniverseNames: async (ids: number[]) =>
      ids.map((id) => ({ id, name: `name-${id}`, category: "inventory_type" })),
  };
}

function struct(id: number, over: Partial<EsiCorporationStructure> = {}) {
  return {
    structureId: id,
    typeId: 35832,
    systemId: 30004268,
    name: `S${id}`,
    state: "shield_vulnerable",
    stateTimerStart: null,
    stateTimerEnd: null,
    fuelExpires: null,
    ...over,
  };
}

/**
 * Designates a holder pinned to CORP, with both scopes granted and a live
 * token, and optionally moves the character's CURRENT corp elsewhere so the
 * corp-changed branch can be exercised.
 */
async function designate(opts: { currentCorp?: number; scopes?: string[] } = {}) {
  const account = await seedAccount(ctx.db);
  await seedCharacter(ctx.db, testConfig(), {
    id: HOLDER,
    accountId: account.id,
    corporationId: opts.currentCorp ?? CORP,
    scopes: opts.scopes ?? [STRUCTURES_SCOPE, NOTIFICATIONS_SCOPE],
    tokenStatus: "valid",
    // The helper encrypts this with the test key itself — never pass a
    // pre-encrypted blob (tests/helpers/seed.ts:33-50).
    refreshToken: "refresh",
  });
  await designateStructureHolder(ctx.db, HOLDER, CORP, account.id);
  return account;
}

function run(esi: StructuresEsi, fetchImpl = okToken) {
  return runStructuresJob({ db: ctx.db, cfg: testConfig(), esi, fetchImpl });
}

describe("runStructuresJob", () => {
  it("returns ok with noHolder when nothing is designated", async () => {
    const res = await run(fakeEsi({}));
    expect(res.status).toBe("ok");
    expect(res.counts?.noHolder).toBe(1);
  });

  it("does not call ESI when the holder lacks the scope", async () => {
    await designate({ scopes: [] });
    let called = false;
    const esi: StructuresEsi = {
      getCorporationStructures: async () => {
        called = true;
        return [];
      },
      getUniverseNames: async () => [],
    };
    const res = await run(esi);
    expect(called).toBe(false);
    expect(res.counts?.scopeMissing).toBe(1);
  });

  it("refuses to read when the holder has left the pinned corporation", async () => {
    await designate({ currentCorp: 98000002 });
    const res = await run(fakeEsi({ structures: [struct(1)] }));
    expect(res.counts?.corpChanged).toBe(1);
    const states = await getReadStates(ctx.db, CORP);
    expect(states.roster.readStatus).toBe("failed");
    expect(states.roster.detail).toBe("corp-changed");
    expect(await getRoster(ctx.db, CORP)).toHaveLength(0);
  });

  it("records forbidden and mutates no roster rows on a corp-roles 403", async () => {
    await designate();
    await run(fakeEsi({ structures: [struct(1)] })); // one good read first
    const res = await run(
      fakeEsi({
        error: new EsiError(
          "Character does not have required role(s)",
          403,
          "permanent",
        ),
      }),
    );
    expect(res.status).toBe("partial");
    const states = await getReadStates(ctx.db, CORP);
    expect(states.roster.readStatus).toBe("forbidden");
    // the last GOOD read's timestamp survives the failure
    expect(states.roster.observedAt).toBeInstanceOf(Date);
    const rows = await getRoster(ctx.db, CORP);
    expect(rows).toHaveLength(1);
    expect(rows[0].missingSince).toBeNull();
  });

  it("pins a corp-roles 403 as permanent, not needs_reauth", () => {
    // Load-bearing on CCP's error PROSE: classifyEsiError maps 403 to
    // needs_reauth only when the body names a scope/token/authorization
    // problem. If CCP reworded this, `forbidden` would start reading as a
    // token fault and send admins round the re-auth loop forever.
    expect(
      classifyEsiError(403, { error: "Character does not have required role(s)" }),
    ).toBe("permanent");
    expect(classifyEsiError(403, { error: "invalid token" })).toBe("needs_reauth");
  });

  it("stamps missingSince rather than deleting a structure that stopped appearing", async () => {
    await designate();
    await run(fakeEsi({ structures: [struct(1), struct(2)] }));
    await run(fakeEsi({ structures: [struct(1)] }));
    const rows = await getRoster(ctx.db, CORP);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.structureId === 2)?.missingSince).toBeInstanceOf(Date);
    expect(rows.find((r) => r.structureId === 1)?.missingSince).toBeNull();
  });

  it("clears missingSince when a structure reappears", async () => {
    await designate();
    await run(fakeEsi({ structures: [struct(1), struct(2)] }));
    await run(fakeEsi({ structures: [struct(1)] }));
    await run(fakeEsi({ structures: [struct(1), struct(2)] }));
    const rows = await getRoster(ctx.db, CORP);
    expect(rows.find((r) => r.structureId === 2)?.missingSince).toBeNull();
  });

  it("keeps a good type name when the name lookup fails", async () => {
    await designate();
    await run(fakeEsi({ structures: [struct(1)] }));
    const esi: StructuresEsi = {
      getCorporationStructures: async () => [struct(1)],
      getUniverseNames: async () => {
        throw new Error("names down");
      },
    };
    await run(esi);
    expect((await getRoster(ctx.db, CORP))[0].typeName).toBe("name-35832");
  });
});
```

`okToken` / `deadToken` / `flakyToken`, `seedAccount`, `seedCharacter`,
`setupTestDb` and `truncateAll` all come from the same places
`tests/access-lists-job.test.ts` gets them — copy those imports from that file.
If `seedCharacter` does not accept `corporationId` / `scopes` / `tokenStatus` /
`refreshTokenEnc`, extend the helper rather than hand-rolling an insert here.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/structure-roster-job.test.ts`
Expected: FAIL — cannot resolve `@/jobs/structures`.

- [ ] **Step 3: Register the job**

`src/core/schedules.ts` — add to `JOB_CRON`, with the slot argument:

```ts
  // :35 is free — :00/:30 membership, :05 contacts, :10 wanderer,
  // :15 discord-roles, :25 access-lists, :02,17,32,47 location. The roster
  // endpoint caches for an hour, so a faster tick would re-read the same page.
  structures: "35 * * * *",
```

and to `JOB_GROUP`:

```ts
  structures: "on-demand",
```

`src/worker/queues.ts` — add `structures: "structures",` to `QUEUES` and
`QUEUES.structures,` to `JOB_QUEUES`.

`src/worker/handlers.ts` — add the schema, the deps type and the handler:

```ts
const structuresSchema = z.object({ jobType: z.literal(QUEUES.structures) }).strict();
```

Widen `JobDeps["esi"]` with `& StructuresEsi`, and add:

```ts
    [QUEUES.structures]: async (data) => {
      structuresSchema.parse(data);
      await runStructuresJob(deps);
    },
```

`src/services/sync-status.ts` — add `"structures"` to `KNOWN_ORDER` after
`"access-lists"`.

- [ ] **Step 4: Write the job**

Create `src/jobs/structures.ts`:

```ts
import { and, eq, inArray, isNull, not } from "drizzle-orm";
import type { Config } from "@/config";
import type { Db } from "@/db";
import { character, structure } from "@/db/schema";
import { EsiError } from "@/lib/esi/client";
import type { StructuresEsi } from "@/lib/esi/client";
import { STRUCTURES_SCOPE } from "@/lib/esi/client";
import {
  getStructureHolder,
  recordReadState,
  stillStructureHolder,
} from "@/services/structures";
import { runJob, type JobResult } from "@/services/sync-run";
import { getFreshAccessToken } from "@/services/tokens";

type Counts = {
  structures: number;
  missing: number;
  noHolder: number;
  scopeMissing: number;
  corpChanged: number;
  skipped: number;
  forbidden: number;
};

/**
 * Refreshes the roster of structures the pinned corporation owns.
 *
 * Staged exactly like the access-lists job: no holder is a normal `ok`, the
 * scope is checked against the PERSISTED grant before any network call, and
 * every write CASes on the holder still being the holder.
 */
export async function runStructuresJob(deps: {
  db: Db;
  cfg: Config;
  esi: StructuresEsi;
  fetchImpl?: typeof fetch;
}): Promise<JobResult> {
  const { db, cfg, esi } = deps;
  return runJob(db, "structures", async () => {
    const counts: Counts = {
      structures: 0,
      missing: 0,
      noHolder: 0,
      scopeMissing: 0,
      corpChanged: 0,
      skipped: 0,
      forbidden: 0,
    };

    // 1. No holder. An unconfigured optional feature must not paint
    //    /admin/sync red — the monitor page explains the missing designation.
    const holder = await getStructureHolder(db);
    if (!holder) {
      counts.noHolder = 1;
      return { status: "ok", counts };
    }

    const [row] = await db
      .select({
        id: character.id,
        corporationId: character.corporationId,
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
    if (!row.scopes.includes(STRUCTURES_SCOPE)) {
      counts.scopeMissing = 1;
      return { status: "ok", counts };
    }

    // 3. The corporation is PINNED. If the holder has moved, reading their new
    //    corp's structures under this designation would stamp missingSince on
    //    every structure of the old one — a fabricated mass-destruction event.
    //    Refuse, and let the page ask for a re-designation.
    if (row.corporationId !== holder.corporationId) {
      counts.corpChanged = 1;
      await recordReadState(db, {
        kind: "roster",
        corporationId: holder.corporationId,
        status: "failed",
        detail: "corp-changed",
        observed: false,
        at: new Date(),
      });
      return { status: "partial", errorSummary: "holder left the pinned corp", counts };
    }

    // 4. Token. getFreshAccessToken has FOUR outcomes and performs its own
    //    invalidation CAS internally, so this job must not repeat it.
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
      return { status: "failed", errorSummary: `holder token ${token.reason}`, counts };
    }

    const at = new Date();
    let rows;
    try {
      rows = await esi.getCorporationStructures(holder.corporationId, token.accessToken);
    } catch (err) {
      // A 403 here is the Station_Manager role missing in game — a normal
      // state this app cannot fix, not a token fault. It classifies
      // `permanent` because the ESI body names a role, not a scope or token.
      const forbidden = err instanceof EsiError && err.status === 403;
      const transient = err instanceof EsiError ? err.kind === "transient" : true;
      counts.forbidden = forbidden ? 1 : 0;
      await recordReadState(db, {
        kind: "roster",
        corporationId: holder.corporationId,
        status: forbidden ? "forbidden" : "failed",
        detail: forbidden ? "station-manager-role" : "read failed",
        observed: false,
        at,
      });
      if (forbidden) {
        // Never retry a permission the app cannot obtain; the hourly tick is
        // enough to notice the role being granted.
        return { status: "partial", errorSummary: "roster read forbidden", counts };
      }
      return {
        status: "failed",
        errorSummary: "roster read failed",
        counts,
        retry: transient || undefined,
      };
    }

    // Resolve type names once per run. Best-effort: a name failure must not
    // fail the roster, since nothing branches on it.
    const typeIds = [...new Set(rows.map((r) => r.typeId))];
    let typeNames = new Map<number, string>();
    try {
      const named = await esi.getUniverseNames(typeIds);
      typeNames = new Map(named.map((n) => [n.id, n.name]));
    } catch {
      // leave typeNames empty; rows keep whatever name they already had
    }

    await db.transaction(async (tx) => {
      if (!(await stillStructureHolder(tx, holder.characterId))) return;
      const seen = rows.map((r) => r.structureId);
      for (const r of rows) {
        const values = {
          structureId: r.structureId,
          corporationId: holder.corporationId,
          typeId: r.typeId,
          typeName: typeNames.get(r.typeId) ?? null,
          systemId: r.systemId,
          name: r.name,
          state: r.state,
          stateTimerStart: r.stateTimerStart,
          stateTimerEnd: r.stateTimerEnd,
          fuelExpires: r.fuelExpires,
          observedAt: at,
          missingSince: null,
        };
        await tx
          .insert(structure)
          .values(values)
          .onConflictDoUpdate({
            target: structure.structureId,
            // typeName only overwrites when this run resolved one, so a failed
            // name lookup does not blank a name that was already good.
            set: {
              ...values,
              typeName: typeNames.get(r.typeId) ?? undefined,
            },
          });
      }
      counts.structures = rows.length;

      // Absent from the response: stamp, never delete. Only rows that are not
      // already stamped, so missingSince records when it FIRST went missing.
      const missing = await tx
        .update(structure)
        .set({ missingSince: at })
        .where(
          and(
            eq(structure.corporationId, holder.corporationId),
            isNull(structure.missingSince),
            seen.length > 0 ? not(inArray(structure.structureId, seen)) : undefined,
          ),
        )
        .returning({ id: structure.structureId });
      counts.missing = missing.length;

      await recordReadState(tx, {
        kind: "roster",
        corporationId: holder.corporationId,
        status: "ok",
        detail: null,
        observed: true,
        at,
      });
    });

    return { status: "ok", counts };
  });
}
```

- [ ] **Step 5: Update the registry expectations**

`tests/worker-queues.test.ts:40-47` holds a literal per-queue list, and
`tests/schedules.test.ts:113-118` and `tests/dispatcher.test.ts:128-132` assert
set equality against `JOB_CRON`. Add `structures` to each.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/structure-roster-job.test.ts tests/schedules.test.ts tests/worker-queues.test.ts tests/dispatcher.test.ts tests/sync-status.test.ts`
Expected: PASS.

- [ ] **Step 7: Format and commit**

```bash
npm run format:check
git add src/jobs/structures.ts src/core/schedules.ts src/worker/queues.ts src/worker/handlers.ts src/services/sync-status.ts tests/
git commit -m "feat(structures): hourly roster job"
```

---

### Task 9: The events job

**Files:**

- Create: `src/jobs/structure-events.ts`
- Modify: `src/core/schedules.ts`, `src/worker/queues.ts`, `src/worker/handlers.ts`, `src/services/sync-status.ts`
- Test: `tests/structure-events-job.test.ts`, plus the same three registry test files

**Interfaces:**

- Consumes: `StructureEventsEsi` (Task 4), the service (Task 6), `extractStructureEvent` / `formatStructureAlert` / `isStructureEventType` (Task 2), `postStructureWebhook` / `resolveStructureWebhookUrl` (Task 5).
- Produces: `runStructureEventsJob(deps: { db: Db; cfg: Config; esi: StructureEventsEsi; fetchImpl?: typeof fetch }): Promise<JobResult>`.

- [ ] **Step 1: Write the failing test**

Create `tests/structure-events-job.test.ts`, same harness as Task 8:

```ts
describe("runStructureEventsJob", () => {
  it("seeds silently on the first poll and sends nothing", async () => {
    const posts: string[] = [];
    const res = await run({ notifications: [attack(1), attack(2)], posts });
    expect(res.status).toBe("ok");
    expect(posts).toHaveLength(0);
    const rows = await ctx.db.select().from(structureEvent);
    expect(rows.map((r) => r.alertStatus)).toEqual(["seeded", "seeded"]);
    expect((await getStructureHolder(ctx.db))?.seededAt).toBeInstanceOf(Date);
  });

  it("alerts only on events new since the seed", async () => {
    const posts: string[] = [];
    await run({ notifications: [attack(1)], posts });
    await run({ notifications: [attack(1), attack(2)], posts });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("under attack");
  });

  it("ignores non-damage notification types entirely", async () => {
    await run({ notifications: [seedOne()] });
    await run({
      notifications: [{ ...attack(9), type: "StructureFuelAlert" }, mailNotification()],
    });
    const rows = await ctx.db.select().from(structureEvent);
    expect(rows.map((r) => r.notificationId)).not.toContain(9);
    expect(rows).toHaveLength(1);
  });

  it("records as seeded, never pending, when no webhook is configured", async () => {
    const cfg = { ...testConfig(), discord: { ...testConfig().discord, opsWebhookUrl: undefined, structureWebhookUrl: undefined } };
    await run({ notifications: [attack(1)], cfg }); // seeds
    await run({ notifications: [attack(1), attack(2)], cfg });
    const rows = await ctx.db.select().from(structureEvent);
    expect(rows.map((r) => r.alertStatus).sort()).toEqual(["seeded", "seeded"]);
    expect(rows.some((r) => r.alertStatus === "sent")).toBe(false);
  });

  it("leaves a row pending and retries it next run when the post fails", async () => {
    await run({ notifications: [attack(1)] }); // seed
    const res = await run({ notifications: [attack(1), attack(2)], postFails: true });
    expect(res.status).toBe("partial");
    let [row] = await ctx.db
      .select()
      .from(structureEvent)
      .where(eq(structureEvent.notificationId, 2));
    expect(row.alertStatus).toBe("pending");

    const posts: string[] = [];
    await run({ notifications: [attack(1), attack(2)], posts });
    expect(posts).toHaveLength(1);
    [row] = await ctx.db
      .select()
      .from(structureEvent)
      .where(eq(structureEvent.notificationId, 2));
    expect(row.alertStatus).toBe("sent");
  });

  it("never posts a pending row belonging to another corporation", async () => {
    await run({ notifications: [attack(1)] }); // seed, corp 98000001
    await ctx.db.insert(structureEvent).values({
      notificationId: 500,
      type: "StructureUnderAttack",
      sentAt: new Date(),
      corporationId: 98000999,
      alertStatus: "pending",
    });
    const posts: string[] = [];
    await run({ notifications: [attack(1), attack(2)], posts });
    expect(posts).toHaveLength(1); // event 2 only, never 500
  });

  it("skips entirely in dry-run without touching the table", async () => {
    const cfg = { ...testConfig(), syncMode: "dry-run" as const };
    const res = await run({ notifications: [attack(1)], cfg });
    expect(res.counts?.skipped).toBe(1);
    expect(await ctx.db.select().from(structureEvent)).toHaveLength(0);
  });

  it("records an event whose body will not parse, and still alerts", async () => {
    await run({ notifications: [attack(1)] });
    const posts: string[] = [];
    await run({
      notifications: [attack(1), { ...attack(2), text: "!!! unparseable" }],
      posts,
    });
    expect(posts).toHaveLength(1);
    const [row] = await ctx.db
      .select()
      .from(structureEvent)
      .where(eq(structureEvent.notificationId, 2));
    expect(row.structureId).toBeNull();
    expect(row.alertStatus).toBe("sent");
  });
});
```

Write `run`, `attack(id)`, `seedOne()` and `mailNotification()` as local helpers
in this file. `run` builds a `StructureEventsEsi` fake, a `postStructureWebhook`
capture (inject via `fetchImpl`, matching how `tests/sync-mode.test.ts` stubs a
webhook post), designates a holder pinned to corp `98000001`, and calls
`runStructureEventsJob`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/structure-events-job.test.ts`
Expected: FAIL — cannot resolve `@/jobs/structure-events`.

- [ ] **Step 3: Register the job**

`src/core/schedules.ts`:

```ts
  // Ten minutes matches the notifications endpoint's 600 s cache exactly —
  // polling faster returns the same cached page. Offset off :00/:05/:10/:15/
  // :25/:30/:35 and location's :02,17,32,47. formatCadence renders evenly
  // spaced comma minutes, so the admin page shows "every 10 minutes" rather
  // than the raw cron.
  "structure-events": "3,13,23,33,43,53 * * * *",
```

```ts
  "structure-events": "on-demand",
```

`src/worker/queues.ts`: `structureEvents: "structure-events",` in `QUEUES`, and
`QUEUES.structureEvents,` in `JOB_QUEUES`.

`src/worker/handlers.ts`: the strict schema, `& StructureEventsEsi` on
`JobDeps["esi"]`, and the handler entry.

`src/services/sync-status.ts`: `"structure-events"` in `KNOWN_ORDER`.

- [ ] **Step 4: Write the job**

Create `src/jobs/structure-events.ts`:

```ts
import { and, asc, eq } from "drizzle-orm";
import type { Config } from "@/config";
import type { Db } from "@/db";
import { character, structure, structureEvent } from "@/db/schema";
import {
  extractStructureEvent,
  formatStructureAlert,
  isStructureEventType,
} from "@/core/structure-event";
import { EsiError, NOTIFICATIONS_SCOPE } from "@/lib/esi/client";
import type { StructureEventsEsi } from "@/lib/esi/client";
import { postStructureWebhook, resolveStructureWebhookUrl } from "@/lib/ops-webhook";
import {
  getStructureHolder,
  markSeeded,
  recordReadState,
  stillStructureHolder,
} from "@/services/structures";
import { runJob, type JobResult } from "@/services/sync-run";
import { getFreshAccessToken } from "@/services/tokens";

type Counts = {
  fetched: number;
  recorded: number;
  alerted: number;
  failedPosts: number;
  noHolder: number;
  scopeMissing: number;
  skipped: number;
  seeded: number;
  unconfigured: number;
};

/**
 * Polls the holder's notifications for structure damage and posts each newly
 * recorded one to Discord.
 *
 * The delivery contract is at-least-once. Rows are inserted `pending` and
 * flipped to `sent` only after a post succeeds, so a crash between the two
 * re-sends on the next tick; a duplicate Discord post is preferred to a lost
 * one. A failed post returns "partial", not "failed" — the ten-minute tick is
 * the retry, and pg-boss's retry budget is for a run that accomplished nothing.
 */
export async function runStructureEventsJob(deps: {
  db: Db;
  cfg: Config;
  esi: StructureEventsEsi;
  fetchImpl?: typeof fetch;
}): Promise<JobResult> {
  const { db, cfg, esi } = deps;
  return runJob(db, "structure-events", async () => {
    const counts: Counts = {
      fetched: 0,
      recorded: 0,
      alerted: 0,
      failedPosts: 0,
      noHolder: 0,
      scopeMissing: 0,
      skipped: 0,
      seeded: 0,
      unconfigured: 0,
    };

    const holder = await getStructureHolder(db);
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
      counts.noHolder = 1;
      return { status: "ok", counts };
    }

    if (!row.scopes.includes(NOTIFICATIONS_SCOPE)) {
      counts.scopeMissing = 1;
      return { status: "ok", counts };
    }

    // The token branch comes BEFORE any insert or post. In dry-run
    // getFreshAccessToken returns `dry_run` without a network call, so this
    // job never reaches the sender — which is what stops a dry-run worker from
    // consuming real pending alerts against a production database.
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
      return { status: "failed", errorSummary: `holder token ${token.reason}`, counts };
    }

    const at = new Date();
    let notifications;
    try {
      notifications = await esi.getCharacterNotifications(row.id, token.accessToken);
    } catch (err) {
      // A 403 here is the Director/CEO role missing in game: corp structure
      // notifications are not delivered to the character at all.
      const forbidden = err instanceof EsiError && err.status === 403;
      const transient = err instanceof EsiError ? err.kind === "transient" : true;
      await recordReadState(db, {
        kind: "events",
        corporationId: holder.corporationId,
        status: forbidden ? "forbidden" : "failed",
        detail: forbidden ? "director-role" : "read failed",
        observed: false,
        at,
      });
      if (forbidden) {
        return { status: "partial", errorSummary: "notifications forbidden", counts };
      }
      return {
        status: "failed",
        errorSummary: "notifications read failed",
        counts,
        retry: transient || undefined,
      };
    }
    counts.fetched = notifications.length;

    // Resolve the recipient BEFORE inserting. postStructureWebhook cannot tell
    // "delivered" from "nowhere to deliver" once it has returned, so a row
    // inserted `pending` on a deployment with no webhook would be marked
    // `sent` by a post that never happened.
    const hasWebhook = resolveStructureWebhookUrl(cfg) !== undefined;
    if (!hasWebhook) counts.unconfigured = 1;
    const seeding = holder.seededAt === null;

    // Only the four damage types are persisted. The endpoint returns every
    // notification the character has — mail, war decs, kill rights, corp
    // applications — and none of those reach Postgres.
    const damage = notifications.filter((n) => isStructureEventType(n.type));

    await db.transaction(async (tx) => {
      if (!(await stillStructureHolder(tx, holder.characterId))) return;
      for (const n of damage) {
        const parsed = extractStructureEvent(n.text);
        const inserted = await tx
          .insert(structureEvent)
          .values({
            notificationId: n.notificationId,
            type: n.type,
            sentAt: n.timestamp,
            structureId: parsed.structureId,
            corporationId: holder.corporationId,
            alertStatus: seeding || !hasWebhook ? "seeded" : "pending",
            details: parsed.details,
          })
          .onConflictDoNothing()
          .returning({ id: structureEvent.notificationId });
        if (inserted.length > 0) counts.recorded += 1;
      }
      if (seeding) {
        counts.seeded = counts.recorded;
        await markSeeded(tx, at);
      }
      await recordReadState(tx, {
        kind: "events",
        corporationId: holder.corporationId,
        status: "ok",
        detail: null,
        observed: true,
        at,
      });
    });

    if (seeding || !hasWebhook) return { status: "ok", counts };

    // Every pending row for the PINNED corp, oldest first. This picks up
    // leftovers from a previous run's failed posts, and excludes anything
    // recorded under a previous holder (those were retired to `abandoned`).
    const pending = await db
      .select({
        notificationId: structureEvent.notificationId,
        type: structureEvent.type,
        structureId: structureEvent.structureId,
        details: structureEvent.details,
      })
      .from(structureEvent)
      .where(
        and(
          eq(structureEvent.corporationId, holder.corporationId),
          eq(structureEvent.alertStatus, "pending"),
        ),
      )
      .orderBy(asc(structureEvent.sentAt));

    for (const event of pending) {
      const [known] = event.structureId
        ? await db
            .select({ name: structure.name, typeName: structure.typeName })
            .from(structure)
            .where(eq(structure.structureId, event.structureId))
        : [];
      const content = formatStructureAlert({
        type: event.type,
        structureName: known?.name ?? null,
        typeName: known?.typeName ?? null,
        systemName: null,
        details: event.details ?? {},
      });
      try {
        await postStructureWebhook(cfg, content, deps.fetchImpl);
        await db
          .update(structureEvent)
          .set({ alertStatus: "sent" })
          .where(eq(structureEvent.notificationId, event.notificationId));
        counts.alerted += 1;
      } catch {
        // Leave the row pending. The ten-minute tick is the retry; burning
        // pg-boss's retry budget on a Discord blip would dead-letter a job
        // that read ESI successfully.
        counts.failedPosts += 1;
      }
    }

    if (counts.failedPosts > 0) {
      return { status: "partial", errorSummary: "some alerts failed to post", counts };
    }
    return { status: "ok", counts };
  });
}
```

- [ ] **Step 5: Update the registry expectations**

Add `structure-events` to the literal lists in `tests/worker-queues.test.ts`,
`tests/schedules.test.ts` and `tests/dispatcher.test.ts`.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/structure-events-job.test.ts tests/schedules.test.ts tests/worker-queues.test.ts tests/dispatcher.test.ts`
Expected: PASS.

- [ ] **Step 7: Format and commit**

```bash
npm run format:check
git add src/jobs/structure-events.ts src/core/schedules.ts src/worker/queues.ts src/worker/handlers.ts src/services/sync-status.ts tests/
git commit -m "feat(structures): ten-minute damage alert job"
```

---

### Task 10: The page's pure view logic

**Files:**

- Create: `src/app/admin/structures/view.ts`
- Test: `tests/structure-view.test.ts`

**Interfaces:**

- Consumes: `RosterRow`, `ReadStateRow` (Task 6).
- Produces: `monitorState`, `monitorSentence`, `monitorRemedy`, `showsRoster`, `rowTone`, `doneNotice`.

- [ ] **Step 1: Write the failing test**

Create `tests/structure-view.test.ts`, covering every arm:

```ts
import { describe, expect, it } from "vitest";
import { monitorRemedy, monitorSentence, monitorState } from "@/app/admin/structures/view";

const base = {
  grantable: null,
  holder: null,
  readStates: {},
  rosterCount: 0,
  webhookConfigured: true,
};

describe("monitorState", () => {
  it("asks for a grant when nobody has one", () => {
    expect(monitorState(base)).toBe("grant-needed");
  });

  it("asks for a designation when a character has the scopes but is not the holder", () => {
    expect(monitorState({ ...base, grantable: { characterId: 1, name: "A" } })).toBe(
      "designate-needed",
    );
  });

  it("puts the dropped scope BEFORE the token fault", () => {
    // the plain re-auth link is what DROPS the scope, so offering it first
    // sends an admin round a loop that cannot terminate
    const state = monitorState({
      ...base,
      holder: {
        characterId: 1,
        name: "A",
        scopes: [],
        tokenStatus: "needs_reauth",
        corporationId: 5,
        currentCorporationId: 5,
      },
    });
    expect(state).toBe("scope-dropped");
  });

  it("reports corp-changed when the holder has left the pinned corp", () => {
    expect(
      monitorState({
        ...base,
        holder: {
          characterId: 1,
          name: "A",
          // Real scope constants, not placeholders: the cascade checks scopes
          // BEFORE the corp comparison, so a holder carrying fake scope strings
          // returns "scope-dropped" and this arm is never reached. A test that
          // cannot reach the state it names proves nothing.
          scopes: [STRUCTURES_SCOPE, NOTIFICATIONS_SCOPE],
          tokenStatus: "valid",
          corporationId: 5,
          currentCorporationId: 6,
        },
      }),
    ).toBe("corp-changed");
  });

  it("names which read is forbidden", () => {
    const state = monitorState({
      ...base,
      holder: healthyHolder(),
      readStates: { events: { readStatus: "forbidden" } },
    });
    expect(state).toBe("no-corp-roles");
    expect(monitorSentence(state, { forbidden: ["events"] })).toContain("notifications");
  });

  it("says alerts are unconfigured rather than claiming they go to Discord", () => {
    expect(
      monitorState({
        ...base,
        holder: healthyHolder(),
        rosterCount: 3,
        webhookConfigured: false,
      }),
    ).toBe("alerts-unconfigured");
    expect(
      monitorState({ ...base, holder: healthyHolder(), rosterCount: 3 }),
    ).toBe("normal");
  });

  it("offers no remedy for states an admin cannot fix from this app", () => {
    expect(monitorRemedy("no-corp-roles")).toBeNull();
    expect(monitorRemedy("alerts-unconfigured")).toBeNull();
    expect(monitorRemedy("grant-needed")).toMatchObject({
      href: "/auth/eve/link?grant=structures",
    });
  });

  it("uses the re-grant link for a dropped scope and the bare link for a token fault", () => {
    expect(monitorRemedy("scope-dropped")?.href).toBe("/auth/eve/link?grant=structures");
    expect(monitorRemedy("holder-needs-reauth")?.href).toBe("/auth/eve/link");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/structure-view.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `view.ts`**

Create `src/app/admin/structures/view.ts`:

```ts
import type { StructureReadStatus } from "@/db/schema";
import type { HolderView } from "@/services/structures";
import { NOTIFICATIONS_SCOPE, STRUCTURES_SCOPE } from "@/lib/esi/client";

export type MonitorState =
  | "grant-needed"
  | "designate-needed"
  | "scope-dropped"
  | "holder-needs-reauth"
  | "holder-no-token"
  | "corp-changed"
  | "no-corp-roles"
  | "roster-empty"
  | "alerts-unconfigured"
  | "normal";

export const GRANT_HREF = "/auth/eve/link?grant=structures";
const REAUTH_HREF = "/auth/eve/link";

// HolderView is declared in @/services/structures (Task 6) and imported above:
// it describes that service read's return shape, and re-declaring it here
// would give the two files a copy each to drift apart.

export type MonitorInput = {
  grantable: { characterId: number; name: string } | null;
  holder: HolderView | null;
  readStates: Partial<Record<"roster" | "events", { readStatus: StructureReadStatus }>>;
  rosterCount: number;
  webhookConfigured: boolean;
};

/**
 * A priority cascade, most blocking first. Total over its input: every arm
 * returns, so a new field cannot leave the page with no sentence to print.
 *
 * Scope BEFORE token, deliberately. A dropped grant and a stale token both
 * want an EVE round trip, but they want DIFFERENT ones: the bare re-auth link
 * is what drops the opt-in scope in the first place, so offering it to a
 * scope-dropped holder sends an admin round a loop that cannot terminate.
 *
 * corp-changed is derived HERE, live, rather than read from
 * structure_read_state.detail — the page must say so the moment affiliation
 * updates, not up to an hour later when the roster job next ticks.
 */
export function monitorState(input: MonitorInput): MonitorState {
  const { holder } = input;
  if (!holder) return input.grantable ? "designate-needed" : "grant-needed";
  const hasScopes =
    holder.scopes.includes(STRUCTURES_SCOPE) &&
    holder.scopes.includes(NOTIFICATIONS_SCOPE);
  if (!hasScopes) return "scope-dropped";
  if (holder.tokenStatus === "needs_reauth") return "holder-needs-reauth";
  if (holder.tokenStatus === "missing" || holder.tokenStatus === "invalid") {
    return "holder-no-token";
  }
  if (
    holder.currentCorporationId !== null &&
    holder.currentCorporationId !== holder.corporationId
  ) {
    return "corp-changed";
  }
  if (forbiddenReads(input).length > 0) return "no-corp-roles";
  if (input.rosterCount === 0) return "roster-empty";
  if (!input.webhookConfigured) return "alerts-unconfigured";
  return "normal";
}

/** Which of the two reads the corp refused. Both can be forbidden at once. */
export function forbiddenReads(input: MonitorInput): ("roster" | "events")[] {
  const out: ("roster" | "events")[] = [];
  if (input.readStates.roster?.readStatus === "forbidden") out.push("roster");
  if (input.readStates.events?.readStatus === "forbidden") out.push("events");
  return out;
}

const READ_LABEL: Record<"roster" | "events", string> = {
  roster: "structure list",
  events: "notifications",
};

export function monitorSentence(
  state: MonitorState,
  ctx: { name?: string; count?: number; forbidden?: ("roster" | "events")[] },
): string {
  const who = ctx.name ?? "The holder";
  switch (state) {
    case "grant-needed":
      return "No character has granted structure access.";
    case "designate-needed":
      return `${who} granted structure access but is not the holder.`;
    case "scope-dropped":
      return `${who} is the holder but no longer grants structure access.`;
    case "holder-needs-reauth":
      return `${who} needs to sign in to EVE again.`;
    case "holder-no-token":
      return `${who} has no usable EVE token.`;
    case "corp-changed":
      return `${who} has left the corporation this roster belongs to.`;
    case "no-corp-roles":
      return `The corporation refused the ${(ctx.forbidden ?? [])
        .map((k) => READ_LABEL[k])
        .join(" and ")} read.`;
    case "roster-empty":
      return "Nothing read yet.";
    case "alerts-unconfigured":
      return `${ctx.count ?? 0} structures. No Discord webhook is set, so nothing is alerted.`;
    case "normal":
      return `${ctx.count ?? 0} structures. Alerts go to Discord.`;
  }
}

export type Remedy = { href: string; label: string };

/**
 * Total exhaustive switch, no `default` arm: adding a MonitorState without
 * deciding its remedy must be a compile error, not a silent null.
 *
 * Three states return null because there is nothing this app can offer. The
 * corp-role grants and the webhook secret are both outside it — a button that
 * cannot fix the problem is worse than a sentence that explains it.
 */
export function monitorRemedy(state: MonitorState): Remedy | null {
  switch (state) {
    case "grant-needed":
      return { href: GRANT_HREF, label: "Grant structure access" };
    case "scope-dropped":
      return { href: GRANT_HREF, label: "Re-grant structure access" };
    case "holder-needs-reauth":
    case "holder-no-token":
      return { href: REAUTH_HREF, label: "Re-authenticate" };
    case "designate-needed":
    case "corp-changed":
    case "no-corp-roles":
    case "roster-empty":
    case "alerts-unconfigured":
    case "normal":
      return null;
  }
}

/** The roster is worth rendering in every state that has one. */
export function showsRoster(state: MonitorState): boolean {
  return (
    state === "normal" ||
    state === "alerts-unconfigured" ||
    state === "no-corp-roles" ||
    state === "corp-changed"
  );
}

/**
 * PRODUCT.md principle 4 reserves alarm colour for what a user can and should
 * fix. access-lists/view.ts:220-227 refuses `bad` on that basis; a structure in
 * hull or armor reinforce is precisely the exception it carves room for — a
 * fight you can still show up to.
 */
export function rowTone(state: string): "bad" | "warn" | "neutral" {
  if (state === "hull_reinforce" || state === "armor_reinforce") return "bad";
  if (state.endsWith("_vulnerable")) return "warn";
  return "neutral";
}
```

`doneNotice` / `doneStamp` are the `?done=…&at=…` redirect-marker helpers —
copy them from `src/app/admin/access-lists/view.ts:285-322`, changing only the
marker names to `holder` and `check`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/structure-view.test.ts`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
npm run format:check
git add src/app/admin/structures/view.ts tests/structure-view.test.ts
git commit -m "feat(structures): monitor state cascade"
```

---

### Task 11: The page, actions and nav

**Files:**

- Create: `src/app/admin/structures/page.tsx`, `src/app/admin/structures/actions.ts`
- Modify: `src/app/_components/nav-items.ts`
- Test: `tests/admin-structure-actions-validation.test.ts`, `tests/nav-items.test.ts` (extend)

**Interfaces:**

- Consumes: everything from Tasks 6 and 10, `enqueueSync` from `@/services/outbox`.
- Produces: `designateStructureHolderAction(formData: FormData): Promise<void>`, `checkNowAction(): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `tests/admin-structure-actions-validation.test.ts`, modelled on
`tests/admin-access-lists-actions-validation.test.ts`:

```ts
it("rejects a non-numeric character id", async () => {
  const fd = new FormData();
  fd.set("characterId", "12abc");
  await expect(designateStructureHolderAction(fd)).rejects.toThrow("invalid_id");
});

it("rejects a negative character id", async () => {
  const fd = new FormData();
  fd.set("characterId", "-1");
  await expect(designateStructureHolderAction(fd)).rejects.toThrow("invalid_id");
});

it("rejects a missing character id", async () => {
  await expect(designateStructureHolderAction(new FormData())).rejects.toThrow(
    "invalid_id",
  );
});
```

Extend `tests/nav-items.test.ts`:

```ts
it("offers Structures to admins and nobody else", () => {
  expect(navFor({ isAdmin: true, tier: "alumni" }).map((i) => i.label)).toContain(
    "Structures",
  );
  expect(navFor({ isAdmin: false, tier: "member" }).map((i) => i.label)).not.toContain(
    "Structures",
  );
});
```

Match the existing `navFor` call signature in that file.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/admin-structure-actions-validation.test.ts tests/nav-items.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `actions.ts`**

Copy `src/app/admin/access-lists/actions.ts`'s `idSchema` / `parseId` verbatim
(including their comments — the reasoning about `FormDataEntryValue | null` and
the `error` codes applies identically), then:

```ts
/**
 * Both actions gate themselves with `requireAdminAction`. The admin layout's
 * guard does not protect server actions and does not re-run on soft
 * navigation, so "the page checked already" is not a check.
 *
 * Neither calls ESI. This page reads Postgres and enqueues; the worker
 * performs every read.
 */
export async function designateStructureHolderAction(formData: FormData): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  const characterId = parseId(formData.get("characterId"));
  const corporationId = parseId(formData.get("corporationId"));
  await designateStructureHolder(getDb(), characterId, corporationId, actor);
  revalidatePath("/admin/structures");
  redirect(`/admin/structures?done=holder&at=${Date.now()}`);
}

/** Asking for a read changes no state, so this writes no audit row. */
export async function checkNowAction(): Promise<void> {
  await requireAdminAction();
  const db = getDb();
  await enqueueSync(db, { kind: "job", jobType: "structures" });
  await enqueueSync(db, { kind: "job", jobType: "structure-events" });
  revalidatePath("/admin/structures");
  redirect(`/admin/structures?done=check&at=${Date.now()}`);
}
```

`corporationId` comes from a hidden input the page renders from the candidate
character's current `character.corporationId`, so the pin records the corp the
admin was actually looking at.

- [ ] **Step 4: Write `page.tsx`**

Create `src/app/admin/structures/page.tsx`. The load-and-derive half is fixed;
the markup follows the access-list page's structure.

```tsx
import type { Metadata } from "next";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { compareRosterRows } from "@/core/structure-event";
import { requireAdminPage } from "@/lib/admin-guard";
import { resolveStructureWebhookUrl } from "@/lib/ops-webhook";
import {
  getReadStates,
  getRecentEvents,
  getRoster,
  getStructureHolder,
} from "@/services/structures";
import { lookupCachedNames } from "@/services/universe-names";
import {
  forbiddenReads,
  monitorRemedy,
  monitorSentence,
  monitorState,
  rowTone,
  showsRoster,
} from "./view";

/**
 * This page reads Postgres and enqueues; the worker performs every read. A
 * live ESI fetch on render would burn a refresh-token rotation per page load.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Structures" };

const RECENT_EVENT_LIMIT = 20;

export default async function StructuresPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The layout guarded, and that is not enough: layouts do not re-run on soft
  // navigation and never see server actions.
  await requireAdminPage();
  const db = getDb();
  const cfg = getConfig();

  const holder = await getStructureHolder(db);
  const corporationId = holder?.corporationId ?? null;
  const [roster, readStates, events] = await Promise.all([
    corporationId ? getRoster(db, corporationId) : Promise.resolve([]),
    corporationId ? getReadStates(db, corporationId) : Promise.resolve({}),
    corporationId
      ? getRecentEvents(db, corporationId, RECENT_EVENT_LIMIT)
      : Promise.resolve([]),
  ]);

  // ONE batched, cache-only name read for every system the two tables print.
  const systemNames = await lookupCachedNames(db, [
    ...new Set(roster.map((r) => r.systemId)),
  ]);

  const input = {
    grantable: await findGrantableCharacter(db),
    holder: holder ? await toHolderView(db, holder) : null,
    readStates,
    rosterCount: roster.length,
    webhookConfigured: resolveStructureWebhookUrl(cfg) !== undefined,
  };
  const state = monitorState(input);
  const rows = [...roster].sort(compareRosterRows);

  return (
    <main id="main" tabIndex={-1} className="page--wide">
      <h1>Structures</h1>
      <p>{monitorSentence(state, {
        name: input.holder?.name,
        count: roster.length,
        forbidden: forbiddenReads(input),
      })}</p>
      {/* remedy button, designate select, Check now — Check now is the ONE
          primary (gold) action on this view */}
      {showsRoster(state) && (
        /* wide table inside its own focusable, labelled, overflow-x region */
        <RosterTable rows={rows} systemNames={systemNames} tone={rowTone} />
      )}
      <RecentEvents events={events} />
    </main>
  );
}
```

`findGrantableCharacter` and `toHolderView` are small local helpers: the first
picks an admin-owned character whose persisted `scopes` carry both structure
scopes; the second joins `character` to fill `name`, `scopes`, `tokenStatus`
and `currentCorporationId`. Put both in `src/services/structures.ts` beside the
other reads rather than in the page, so `view.ts` stays testable without a
React import.

Design constraints, all from DESIGN.md — a reviewer will check these:

- no zebra striping; hairline row rules; `--hull` header; mono uppercase labels
- status `ok` is neutral `--ink-dim` — **do not** restore the green
- alarm is `--signal-bad` **border and text, never filled**
- gold is rationed to one primary action per view — that is `Check now`
- hit targets: 36px standalone (`.btn`), 28px in-row (`.btn--micro`)
- the wide roster table scrolls inside its own focusable, labelled region
- `<main id="main" tabIndex={-1}>`, and `prefers-reduced-motion` honoured globally

- [ ] **Step 5: Add the nav entry**

In `src/app/_components/nav-items.ts`, add `Structures` after `Access lists`,
admin-only, and update the rule table in the module docblock — the list in that
comment is the specification, not decoration.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/admin-structure-actions-validation.test.ts tests/nav-items.test.ts && npm run typecheck`
Expected: PASS, and typecheck clean.

- [ ] **Step 7: Format and commit**

```bash
npm run format:check
git add src/app/admin/structures src/app/_components/nav-items.ts tests/
git commit -m "feat(structures): admin monitor page"
```

---

### Task 12: e2e, docs, and the full gate

**Files:**

- Create: `e2e/structures.spec.ts`
- Modify: `docs/ops.md`
- Test: the whole suite

**Coverage boundary — read this before writing the spec file.** Playwright runs
`SYNC_MODE: "dry-run"` (`playwright.config.ts:27-73`), and dry-run makes
`getFreshAccessToken` return before any network call, so **no e2e test can reach
an ESI fetch**. e2e covers the state cascade, designation, and rendering from
rows seeded directly into Postgres. Every alerting behaviour is already proven
in Tasks 8 and 9. Do not write an e2e test that expects a job to fetch anything.

- [ ] **Step 1: Write the e2e spec**

Create `e2e/structures.spec.ts` using `seedMember(db, { isAdmin: true })` and
`sessionCookieFor` from `e2e/helpers.ts`:

```ts
test("an admin with no holder is asked to grant", async ({ page, context }) => {
  // seed admin, add cookie, goto /admin/structures
  await expect(page.getByRole("main")).toContainText("No character has granted");
});

test("a seeded roster renders most-alarming-first", async ({ page, context }) => {
  // insert a holder + three structure rows directly, one hull_reinforce
  const rows = page.locator(".log--dense > tbody > tr");
  await expect(rows.first()).toContainText("hull");
});

test("Structures appears in the admin nav and not for a plain member", async ({
  page,
  context,
}) => {
  // two seeded sessions, two assertions
});
```

- [ ] **Step 2: Run the e2e spec**

Run: `npx playwright test e2e/structures.spec.ts`
Expected: PASS. Never run two e2e suites at once in the same worktree — they
share one database and truncate each other.

- [ ] **Step 3: Document the operational surface**

In `docs/ops.md`:

- add `DISCORD_STRUCTURE_WEBHOOK_URL` to the secret table (`:348-371`) as
  `no (falls back to DISCORD_OPS_WEBHOOK_URL)`
- add both new jobs to the job-schedule table (`:106-116`) and update the free-slot
  note at `:118-120`
- add a `### The structure scopes are opt-in` subsection modelled on the
  access-list one at `:415-430`, naming both scopes, the `?grant=structures`
  link, and — the part the access-list section has no equivalent for — the two
  **in-game corp roles** nobody can grant from this app: Station_Manager for the
  roster, Director or CEO for notification delivery
- add `structure_event` to the unbounded-tables note at `:240-255`, beside
  `audit_log` and `sync_run`: append-only record of fact, deliberately not purged
- state that with no webhook configured, events are recorded `seeded` and
  nothing is alerted, and `/admin/structures` says so

- [ ] **Step 4: Run the full gate**

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npx playwright test
```

All six must pass. `npm run build` and `npm run typecheck` are CI gates in
their own right (`.github/workflows/ci.yml`), not implied by the tests.

- [ ] **Step 5: Commit**

```bash
git add e2e/structures.spec.ts docs/ops.md
git commit -m "test(structures): e2e coverage and operational docs"
```

---

## Verification checklist

Before calling this done:

- [ ] `npm test` — cite the file and test counts; compare the file count against
      `main` (99 before this feature), since a load failure silently drops tests
- [ ] `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`
- [ ] `npx playwright test`
- [ ] `git diff main --stat` reviewed for scope creep
- [ ] The generated migration `ALTER`s no existing table
- [ ] No `console.log`, no `TODO`, no placeholder left behind
