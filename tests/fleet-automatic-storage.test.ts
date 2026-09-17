import { randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { fleetStopReceiptCheck } from "@/db/fleet-automatic-checks";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDb } from "@/db";
import { MANAGED_TABLE_NAMES } from "@/db/tables";
import { TEST_URL } from "./helpers/db";

// Same owned main database and global test lock. Never replay/reset the separate
// pinned legacy database. On the first run this retains a real 0025 manual row
// across migrate(); repeat runs still check defaults, SQL metadata and retention.
let ctx: ReturnType<typeof createDb>;
const owner = randomUUID();
const device = randomUUID();
const link = randomUUID();
const request = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const now = "2026-09-07T12:00:00.000Z";
const expiry = "2026-09-08T12:00:00.000Z";
const consent = {
  generation: 7,
  revision: 9,
  enabled: false,
  approving_device_id: device,
  approved_at: "2026-09-07T11:00:00.000Z",
  disabled_at: now,
  closed_reason: "explicit_off",
};
const automaticReceipt = {
  kind: "automatic",
  command: {
    protocol: 2,
    request_id: request,
    intent_created_at: now,
    enabled: false,
    expected_generation: 7,
    expected_revision: 8,
  },
  accepted_at: now,
  expires_at: expiry,
  result: consent,
};
beforeAll(async () => {
  ctx = createDb(TEST_URL);
  await ctx.pool.query("insert into account(id) values ($1)", [owner]);
});
afterAll(async () => {
  // The ordinary shared registry must clean up all new storage on later files.
  await ctx.pool.end();
});

async function manualSource(id = randomUUID()) {
  const {
    rows: [row],
  } = await ctx.pool.query<{ id: string }>(
    `insert into fleet_source_intent
    (id, account_id, device_id, boss_character_id, boss_owner_hash, boss_link_epoch,
    state, intent_created_at, intent_expires_at, retain_until)
    values ($1, $2, $3, 42, 'owner-hash', $4, 'pending', $5, $5::timestamptz + interval '60 seconds', $5::timestamptz + interval '25 hours') returning *`,
    [id, owner, device, link, now],
  );
  return row;
}

it("retains a pre-migration manual source without inferred consent or provenance", async () => {
  const before = await manualSource();
  const history = await ctx.pool.query(
    "select hash from drizzle.__drizzle_migrations order by created_at",
  );
  expect(
    history.rows.some(
      (r) =>
        r.hash === "ebe66363a6e77d49e4ebe7f15f657c18707128f871881557859e50f4f43eb40b",
    ),
  ).toBe(true);
  await migrate(ctx.db, { migrationsFolder: "drizzle" });
  const {
    rows: [after],
  } = await ctx.pool.query("select * from fleet_source_intent where id = $1", [
    before.id,
  ]);
  expect(after).toMatchObject(before);
  expect(after).toMatchObject({
    automatic_consent_account_id: null,
    automatic_consent_generation: null,
    stop_receipt: null,
    explicitly_stopped: false,
  });
  expect(
    (
      await ctx.pool.query(
        "select * from fleet_automatic_consent where account_id = $1",
        [owner],
      )
    ).rows,
  ).toEqual([]);
  expect(
    (
      await ctx.pool.query(
        "select * from fleet_automatic_candidate where account_id = $1",
        [owner],
      )
    ).rows,
  ).toEqual([]);
  expect(
    (
      await ctx.pool.query(
        "select * from fleet_automatic_receipt where account_id = $1",
        [owner],
      )
    ).rows,
  ).toEqual([]);
  const fks = await ctx.pool
    .query(`select pg_get_constraintdef(oid) as definition from pg_constraint
    where conrelid = 'fleet_source_intent'::regclass and contype = 'f'`);
  expect(fks.rows).toEqual([]);
  for (const table of [
    "fleet_automatic_consent",
    "fleet_automatic_receipt",
    "fleet_automatic_candidate",
  ])
    expect(MANAGED_TABLE_NAMES).toContain(table);
});

it("persists positive attributed consent only, with safe counters and finite canonical dates", async () => {
  await ctx.pool.query(
    `insert into fleet_automatic_consent
    (account_id, generation, revision, enabled, approving_device_id, approved_at, next_reconcile_at)
    values ($1, 7, 8, true, $2, $3, $3)`,
    [owner, device, now],
  );
  for (const assignment of [
    "generation = 0",
    "generation = -1",
    "revision = 6",
    "revision = 9007199254740992",
    "approving_device_id = null",
    "approved_at = null",
    "disabled_at = now()",
    "closed_reason = 'explicit_off'",
    "next_reconcile_at = 'infinity'",
    "next_reconcile_at = '10000-01-01'",
    "candidate_cursor = 0",
    "candidate_cursor = 9007199254740992",
    "revision = 9007199254740991",
  ])
    await expect(
      ctx.pool.query(
        `update fleet_automatic_consent set ${assignment} where account_id = $1`,
        [owner],
      ),
      assignment,
    ).rejects.toThrow();
  await ctx.pool.query(
    `update fleet_automatic_consent set enabled = false, revision = 9007199254740991,
    disabled_at = $2, closed_reason = 'explicit_off' where account_id = $1`,
    [owner, now],
  );
  for (const assignment of [
    "disabled_at = null",
    "closed_reason = null",
    "closed_reason = 'unknown'",
    "disabled_at = '2026-09-06'",
    "disabled_at = 'infinity'",
  ])
    await expect(
      ctx.pool.query(
        `update fleet_automatic_consent set ${assignment} where account_id = $1`,
        [owner],
      ),
      assignment,
    ).rejects.toThrow();
});

it("enforces paired account provenance and one live automatic source per binding without provenance FKs", async () => {
  const row = await manualSource();
  for (const assignment of [
    "automatic_consent_generation = 1",
    `automatic_consent_account_id = '${owner}'`,
    `automatic_consent_account_id = '${owner}', automatic_consent_generation = 0`,
    `automatic_consent_account_id = '${randomUUID()}', automatic_consent_generation = 1`,
    `automatic_consent_account_id = '${owner}', automatic_consent_generation = 9007199254740992`,
    "generation = 2147483647",
    "fetch_generation = 2147483647",
    "intent_created_at = '-infinity'",
  ])
    await expect(
      ctx.pool.query(`update fleet_source_intent set ${assignment} where id = $1`, [
        row.id,
      ]),
      assignment,
    ).rejects.toThrow();
  await ctx.pool.query(
    `update fleet_source_intent set automatic_consent_account_id = $2, automatic_consent_generation = 7 where id = $1`,
    [row.id, owner],
  );
  const other = await manualSource();
  await expect(
    ctx.pool.query(
      `update fleet_source_intent set automatic_consent_account_id = $2, automatic_consent_generation = 7 where id = $1`,
      [other.id, owner],
    ),
  ).rejects.toMatchObject({ code: "23505" });
  await ctx.pool.query(
    `update fleet_source_intent set state = 'ended', ended_at = $2, terminal_reason = 'expired', generation = 2147483647, fetch_generation = 2147483647 where id = $1`,
    [row.id, now],
  );
  await ctx.pool.query(
    `update fleet_source_intent set automatic_consent_account_id = $2, automatic_consent_generation = 7 where id = $1`,
    [other.id, owner],
  );
  await ctx.pool.query("delete from fleet_source_intent where id = $1", [other.id]);
});

it("bounds and closes automatic receipt JSON independently of TypeScript and ties its lookup columns", async () => {
  const insert = (receipt: unknown, id = request, expiresAt = expiry) =>
    ctx.pool.query(
      `insert into fleet_automatic_receipt
    (account_id, request_id, expires_at, receipt) values ($1, $2, $3, $4::jsonb)`,
      [owner, id, expiresAt, JSON.stringify(receipt)],
    );
  for (const receipt of [
    null,
    [],
    {},
    { ...automaticReceipt, extra: "x" },
    { ...automaticReceipt, command: { ...automaticReceipt.command, account_id: owner } },
    {
      ...automaticReceipt,
      command: { ...automaticReceipt.command, expected_revision: true },
    },
    {
      ...automaticReceipt,
      command: { ...automaticReceipt.command, expected_revision: 8.5 },
    },
    { ...automaticReceipt, result: { ...consent, generation: 0 } },
    { ...automaticReceipt, result: { ...consent, revision: 8 } },
    { ...automaticReceipt, result: { ...consent, approved_at: null } },
    { ...automaticReceipt, expires_at: "2026-09-08T12:00:00.001Z" },
    { ...automaticReceipt, accepted_at: "0000-01-01T00:00:00.000Z" },
    {
      ...automaticReceipt,
      command: {
        ...automaticReceipt.command,
        intent_created_at: "2026-09-07T12:00:00.001Z",
      },
    },
    { ...automaticReceipt, extra: "x".repeat(2048) },
  ])
    await expect(insert(receipt), JSON.stringify(receipt)).rejects.toThrow();
  await expect(insert(automaticReceipt, randomUUID())).rejects.toThrow();
  await expect(
    insert(automaticReceipt, request, "2026-09-09T12:00:00.000Z"),
  ).rejects.toThrow();
  await insert(automaticReceipt);
  await expect(insert(automaticReceipt)).rejects.toMatchObject({ code: "23505" });
});

it("retains the inline Stop fence after payload expiry with exact bounded receipt/source correlation", async () => {
  const row = await manualSource();
  await ctx.pool.query(
    "update fleet_source_intent set state = 'ended', ended_at = $2, terminal_reason = 'stopped' where id = $1",
    [row.id, now],
  );
  const receipt = {
    kind: "source_stop",
    command: {
      protocol: 2,
      operation: "stop",
      request_id: randomUUID(),
      source_id: row.id,
      expected_generation: 1,
      expected_automatic: null,
      intent_created_at: now,
    },
    accepted_at: now,
    expires_at: expiry,
    source: {
      source_id: row.id,
      generation: 1,
      character_id: 42,
      state: "ended",
      reason: "stopped",
      pending_expires_at: null,
      automatic: null,
    },
    automatic_effect: "manual_only",
    consent,
  };
  const set = (value: unknown, fence = true) =>
    ctx.pool.query(
      "update fleet_source_intent set stop_receipt = $2::jsonb, explicitly_stopped = $3 where id = $1",
      [row.id, JSON.stringify(value), fence],
    );
  for (const value of [
    [],
    {},
    { ...receipt, extra: "x" },
    { ...receipt, source: { ...receipt.source, source_id: randomUUID() } },
    { ...receipt, command: { ...receipt.command, expected_generation: 2147483647 } },
    {
      ...receipt,
      command: { ...receipt.command, expected_automatic: { consent_generation: 7 } },
    },
    { ...receipt, source: { ...receipt.source, state: "active" } },
    { ...receipt, automatic_effect: "disabled_current" },
    { ...receipt, consent: { ...consent, revision: true } },
    { ...receipt, expires_at: "2026-09-08T12:00:00.001Z" },
    {
      ...receipt,
      command: { ...receipt.command, intent_created_at: "2026-09-07T11:59:00.000Z" },
    },
  ])
    await expect(set(value)).rejects.toThrow();
  await expect(set(receipt, false)).rejects.toThrow();
  await set(receipt);
  await ctx.pool.query(
    "update fleet_source_intent set stop_receipt = null where id = $1",
    [row.id],
  );
  expect(
    (
      await ctx.pool.query(
        "select explicitly_stopped, stop_receipt from fleet_source_intent where id = $1",
        [row.id],
      )
    ).rows,
  ).toEqual([{ explicitly_stopped: true, stop_receipt: null }]);
});

it("stores candidate bindings only with checked counters, paired and exclusive reservations, and no work creation", async () => {
  await ctx.pool.query(
    `insert into fleet_automatic_candidate
    (account_id, character_id, consent_generation, candidate_generation, owner_hash, link_epoch, next_attempt_at)
    values ($1, 42, 7, 1, 'owner-hash', $2, $3)`,
    [owner, link, now],
  );
  const mutate = (assignment: string) =>
    ctx.pool.query(
      `update fleet_automatic_candidate set ${assignment} where account_id = $1 and character_id = 42`,
      [owner],
    );
  for (const assignment of [
    "consent_generation = 0",
    "candidate_generation = 0",
    "candidate_generation = 9007199254740992",
    "claim_generation = -1",
    "claim_generation = 9007199254740992",
    "character_id = 0",
    "failure_count = -1",
    "failure_count = 7",
    "last_outcome = 'provider_secret'",
    "next_attempt_at = 'infinity'",
    "next_attempt_at = '10000-01-01'",
    `reservation_id = '${request}'`,
    "enqueue_until = now()",
    `claim_reservation_id = '${request}'`,
    "claim_expires_at = now()",
    "source_id = '11111111-1111-1111-8111-111111111111'",
  ])
    await expect(mutate(assignment), assignment).rejects.toThrow();
  await mutate(`reservation_id = '${request}', enqueue_until = '${now}'`);
  await expect(
    mutate(
      `claim_reservation_id = '${request}', claim_expires_at = '${now}', claim_generation = 1`,
    ),
  ).rejects.toThrow();
  await expect(mutate("candidate_generation = 9007199254740991")).rejects.toThrow();
  await expect(mutate("claim_generation = 9007199254740991")).rejects.toThrow();
  await mutate(
    "reservation_id = null, enqueue_until = null, candidate_generation = 9007199254740991, claim_generation = 9007199254740991, failure_count = 6, last_outcome = 'capacity_limited'",
  );
  await expect(
    ctx.pool.query(
      `insert into fleet_automatic_candidate
    (account_id, character_id, consent_generation, candidate_generation, owner_hash, link_epoch, next_attempt_at)
    values ($1, 42, 7, 1, 'owner-hash', $2, $3)`,
      [owner, link, now],
    ),
  ).rejects.toMatchObject({ code: "23505" });
  const columns = await ctx.pool.query<{ column_name: string }>(
    "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'fleet_automatic_candidate'",
  );
  expect(columns.rows.map((r) => r.column_name).sort()).toEqual(
    [
      "account_id",
      "character_id",
      "consent_generation",
      "candidate_generation",
      "owner_hash",
      "link_epoch",
      "next_attempt_at",
      "failure_count",
      "last_outcome",
      "reservation_id",
      "enqueue_until",
      "claim_reservation_id",
      "claim_generation",
      "claim_expires_at",
      "source_id",
    ].sort(),
  );
});

it.each([
  {
    name: "enabled with reserve",
    enabled: true,
    revision: 9007199254740990,
    accept: true,
  },
  {
    name: "enabled without reserve",
    enabled: true,
    revision: 9007199254740991,
    accept: false,
  },
  {
    name: "terminal maximum Off",
    enabled: false,
    revision: 9007199254740991,
    accept: true,
  },
])("inline receipt terminal reserve: $name", async ({ enabled, revision, accept }) => {
  const id = randomUUID();
  const receipt = {
    kind: "source_stop",
    command: {
      protocol: 2,
      operation: "stop",
      request_id: randomUUID(),
      source_id: id,
      expected_generation: 1,
      expected_automatic: null,
      intent_created_at: now,
    },
    accepted_at: now,
    expires_at: expiry,
    source: {
      source_id: id,
      generation: 1,
      character_id: 42,
      state: "ended",
      reason: "stopped",
      pending_expires_at: null,
      automatic: null,
    },
    automatic_effect: "manual_only",
    consent: {
      ...consent,
      enabled,
      revision,
      disabled_at: enabled ? null : now,
      closed_reason: enabled ? null : "explicit_off",
    },
  };
  const payload = JSON.stringify(receipt);
  // Execute the actual schema expression as well as the installed constraint:
  // reverting the generator helper must fail even after its migration is applied.
  const predicate = await ctx.db.execute(
    sql`select ${fleetStopReceiptCheck(
      sql`${payload}::jsonb`,
      sql`${id}::uuid`,
      sql`1`,
      sql`null::bigint`,
      sql`${now}::timestamptz + interval '25 hours'`,
    )} as accepted`,
  );
  expect.soft(predicate.rows[0]?.accepted).toBe(accept);
  const client = await ctx.pool.connect();
  try {
    await client.query("begin");
    const insert = client.query<{ stop_receipt: typeof receipt }>(
      `insert into fleet_source_intent
      (id, account_id, device_id, boss_character_id, boss_owner_hash, boss_link_epoch,
      state, intent_created_at, intent_expires_at, retain_until, ended_at, terminal_reason, explicitly_stopped, stop_receipt)
      values ($1, $2, $3, 42, 'owner-hash', $4, 'ended', $5, $5::timestamptz + interval '60 seconds',
        $5::timestamptz + interval '25 hours', $5, 'stopped', true, $6::jsonb) returning stop_receipt`,
      [id, owner, device, link, now, payload],
    );
    if (accept) expect((await insert).rows[0].stop_receipt).toEqual(receipt);
    else
      await expect(insert).rejects.toMatchObject({
        code: "23514",
        constraint: "fleet_source_intent_stop_receipt_ck",
      });
  } finally {
    // RED at 0026 must not leave the deliberately invalid row to block 0027.
    await client.query("rollback");
    client.release();
  }
});

it("cascades ordinary account consent/receipts/candidates but preserves source provenance", async () => {
  await ctx.pool.query("delete from account where id = $1", [owner]);
  for (const table of [
    "fleet_automatic_consent",
    "fleet_automatic_receipt",
    "fleet_automatic_candidate",
  ])
    expect(
      (await ctx.pool.query(`select * from ${table} where account_id = $1`, [owner]))
        .rows,
    ).toEqual([]);
  const retained = await ctx.pool.query(
    "select automatic_consent_account_id, automatic_consent_generation from fleet_source_intent where automatic_consent_account_id = $1",
    [owner],
  );
  expect(retained.rows).toEqual([
    { automatic_consent_account_id: owner, automatic_consent_generation: "7" },
  ]);
});
