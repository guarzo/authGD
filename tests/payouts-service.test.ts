import { asc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "@/config";
import {
  auditLog,
  lootItem,
  lootPool,
  payoutOperation,
  payoutParticipant,
  payoutPayment,
} from "@/db/schema";
import { unlinkCharacter } from "@/services/accounts";
import { addAppraisedPool, deletePool, setItemPrice } from "@/services/payout-loot";
import {
  PayoutForbiddenError,
  PayoutLockedError,
  PayoutNotFoundError,
  addParticipant,
  canReadPayouts,
  createOperation,
  finalizeOperation,
  getOpenInfoTarget,
  recalculate,
  recordPayment,
  removeParticipant,
  requirePayoutOperator,
  resolveRosterNames,
  revertPayment,
  setCorpSharePct,
  setParticipantExcluded,
  setParticipantShares,
  setRoster,
  unlockOperation,
  type RosterEntry,
} from "@/services/payouts";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedAccount, seedCharacter } from "./helpers/seed";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
let cfg: Config;

beforeAll(async () => {
  ctx = await setupTestDb();
  cfg = loadConfig({
    DATABASE_URL: "postgres://x/y",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    APP_BASE_URL: "https://auth.example",
    ALLIANCE_ID: "99000001",
    BOOTSTRAP_ADMIN_CHARACTER_IDS: "",
    EVE_SSO_CLIENT_ID: "c",
    EVE_SSO_CLIENT_SECRET: "s",
    EVE_SSO_SCOPES: "esi-characters.read_contacts.v1",
    DISCORD_CLIENT_ID: "d",
    DISCORD_CLIENT_SECRET: "d",
    DISCORD_BOT_TOKEN: "d",
    DISCORD_GUILD_ID: "1",
    DISCORD_ROLE_ID_FLYGD: "10",
    DISCORD_ROLE_ID_BLUE: "11",
    DISCORD_ROLE_ID_GREEN: "12",
    WANDERER_BASE_URL: "https://w.example",
    WANDERER_API_KEY: "k",
    WANDERER_ACL_ID: "a",
    ESI_CONTACT: "ops@example.com",
    SYNC_MODE: "live",
  } as unknown as NodeJS.ProcessEnv);
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

async function seedOperator() {
  return seedAccount(ctx.db, { tier: "flygd", status: "active" });
}

/** A finalized operation with one unpaid participant owed the whole 1000.00.
 *  The pool is inserted directly rather than through `addFlatPool` so the
 *  helper does not depend on Task 8; `setRoster` runs afterwards and its
 *  `recalculate` is what assigns the amount. */
async function seedFightWithOneUnpaidParticipant() {
  const operator = await seedOperator();
  const { id: operationId } = await ctx.db.transaction((tx) =>
    createOperation(tx, operator.id, {
      name: "Thursday roam",
      occurredAt: new Date(),
      corpSharePct: "0",
    }),
  );
  const [pool] = await ctx.db
    .insert(lootPool)
    .values({
      operationId,
      valuationSource: "flat",
      totalValue: "1000.00",
      notes: "sold privately",
    })
    .returning();
  const roster: RosterEntry[] = [
    {
      displayName: "Line Member",
      accountId: null,
      recipientCharacterId: null,
      sourceCharacters: ["Line Member"],
      shares: "1",
      excluded: false,
    },
  ];
  await ctx.db.transaction((tx) => setRoster(tx, operator.id, operationId, roster));
  const [participant] = await ctx.db
    .select()
    .from(payoutParticipant)
    .where(eq(payoutParticipant.operationId, operationId));
  await ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, operationId));
  return { operator, operationId, participantId: participant.id, poolId: pool.id };
}

async function seedFightWithOnePaidParticipant() {
  const seeded = await seedFightWithOneUnpaidParticipant();
  await ctx.db.transaction((tx) =>
    recordPayment(tx, seeded.operator.id, seeded.participantId),
  );
  return seeded;
}

describe("requirePayoutOperator", () => {
  it("refuses a cryo flygd account", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd", status: "cryo" });
    await expect(requirePayoutOperator(ctx.db, acc.id)).rejects.toThrow(
      PayoutForbiddenError,
    );
  });

  it("refuses an active green account", async () => {
    const acc = await seedAccount(ctx.db, { tier: "green", status: "active" });
    await expect(requirePayoutOperator(ctx.db, acc.id)).rejects.toThrow(
      PayoutForbiddenError,
    );
  });

  it("allows an active flygd account", async () => {
    const acc = await seedOperator();
    await expect(requirePayoutOperator(ctx.db, acc.id)).resolves.toBeUndefined();
  });
});

describe("canReadPayouts", () => {
  /**
   * The one authorization rule in this file that deliberately differs from
   * the mutation rule: tier only, any status. This is the design's explicit
   * promise that a demoted or cryo member keeps read access — a later
   * "consistency" edit adding `&& status === "active"` here must fail this.
   */
  it("allows a cryo flygd account to read", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd", status: "cryo" });
    await expect(canReadPayouts(ctx.db, acc.id)).resolves.toBe(true);
  });

  it("refuses an active green account", async () => {
    const acc = await seedAccount(ctx.db, { tier: "green", status: "active" });
    await expect(canReadPayouts(ctx.db, acc.id)).resolves.toBe(false);
  });

  it("refuses a missing account", async () => {
    await expect(
      canReadPayouts(ctx.db, "00000000-0000-0000-0000-000000000000"),
    ).resolves.toBe(false);
  });
});

describe("resolveRosterNames", () => {
  it("collapses two alts of one account into one entry named for the main", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, {
      id: 500001,
      accountId: acc.id,
      name: "Main Guy",
      main: true,
    });
    await seedCharacter(ctx.db, cfg, { id: 500002, accountId: acc.id, name: "Alt Guy" });

    const entries = await resolveRosterNames(ctx.db, [
      "Alt Guy",
      "Unknown Pilot",
      "Main Guy",
    ]);

    expect(entries).toHaveLength(2);
    const known = entries.find((e) => e.accountId === acc.id)!;
    expect(known.displayName).toBe("Main Guy");
    expect(known.recipientCharacterId).toBe(500001);
    expect(known.sourceCharacters).toEqual(["Alt Guy", "Main Guy"]);
    expect(known.shares).toBe("1");
    expect(known.excluded).toBe(false);

    const unknown = entries.find((e) => e.accountId === null)!;
    expect(unknown.displayName).toBe("Unknown Pilot");
    expect(unknown.recipientCharacterId).toBeNull();
    expect(unknown.sourceCharacters).toEqual(["Unknown Pilot"]);
  });
});

describe("recalculation safety", () => {
  it("recalculating after a payment leaves paidAmount untouched while amount moves", async () => {
    const { operationId, participantId, poolId, operator } =
      await seedFightWithOnePaidParticipant();
    const [paid] = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.id, participantId));
    expect(paid.amount).toBe("1000.00");
    expect(paid.paidAmount).toBe("1000.00");

    // Simulate the underlying loot value changing after payment (an operator
    // correcting a mis-typed flat total) and recalculate being invoked again.
    await ctx.db
      .update(lootPool)
      .set({ totalValue: "1200.00" })
      .where(eq(lootPool.id, poolId));
    await ctx.db.transaction((tx) => recalculate(tx, operationId));

    const [after] = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.id, participantId));
    expect(after.amount).toBe("1200.00"); // moved
    expect(after.paidAmount).toBe("1000.00"); // untouched
    void operator;
  });

  it("rejects a payout-affecting edit once a payment exists", async () => {
    const { operationId, participantId, operator } =
      await seedFightWithOnePaidParticipant();
    await expect(
      ctx.db.transaction((tx) =>
        setParticipantShares(tx, operator.id, participantId, "2"),
      ),
    ).rejects.toThrow(PayoutLockedError);
    await expect(
      ctx.db.transaction((tx) =>
        setParticipantExcluded(tx, operator.id, participantId, true),
      ),
    ).rejects.toThrow(PayoutLockedError);
    await expect(
      ctx.db.transaction((tx) => removeParticipant(tx, operator.id, participantId)),
    ).rejects.toThrow(PayoutLockedError);
    await expect(
      ctx.db.transaction((tx) => unlockOperation(tx, operator.id, operationId)),
    ).rejects.toThrow(PayoutLockedError);
  });

  it("unlinking a character in a paid operation leaves the participant row intact and readable", async () => {
    const operator = await seedOperator();
    const member = await seedAccount(ctx.db, { tier: "blue", status: "active" });
    await seedCharacter(ctx.db, cfg, {
      id: 600001,
      accountId: member.id,
      name: "Payee Main",
      main: true,
    });
    // second character so unlinkCharacter doesn't refuse as last_character
    await seedCharacter(ctx.db, cfg, {
      id: 600002,
      accountId: member.id,
      name: "Payee Spare",
    });

    const { id: operationId } = await ctx.db.transaction((tx) =>
      createOperation(tx, operator.id, {
        name: "Fight with a payee",
        occurredAt: new Date(),
        corpSharePct: "0",
      }),
    );
    await ctx.db.insert(lootPool).values({
      operationId,
      valuationSource: "flat",
      totalValue: "500.00",
      notes: "sold privately",
    });
    const roster: RosterEntry[] = [
      {
        displayName: "Payee Main",
        accountId: member.id,
        recipientCharacterId: 600001,
        sourceCharacters: ["Payee Main"],
        shares: "1",
        excluded: false,
      },
    ];
    await ctx.db.transaction((tx) => setRoster(tx, operator.id, operationId, roster));
    const [participant] = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.operationId, operationId));
    await ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, operationId));
    await ctx.db.transaction((tx) => recordPayment(tx, operator.id, participant.id));

    const result = await ctx.db.transaction((tx) =>
      unlinkCharacter(tx, cfg, member.id, 600001),
    );
    expect(result).toEqual({ ok: true });

    const [after] = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.id, participant.id));
    expect(after.displayName).toBe("Payee Main");
    expect(after.amount).toBe("500.00");
    expect(after.paidAmount).toBe("500.00");
    expect(after.recipientCharacterId).toBeNull();
  });
});

describe("recordPayment", () => {
  it("refuses a draft operation", async () => {
    const operator = await seedOperator();
    const { id: operationId } = await ctx.db.transaction((tx) =>
      createOperation(tx, operator.id, {
        name: "Draft fight",
        occurredAt: new Date(),
        corpSharePct: "0",
      }),
    );
    await ctx.db
      .insert(lootPool)
      .values({ operationId, valuationSource: "flat", totalValue: "100.00", notes: "n" });
    await ctx.db.transaction((tx) =>
      setRoster(tx, operator.id, operationId, [
        {
          displayName: "Someone",
          accountId: null,
          recipientCharacterId: null,
          sourceCharacters: ["Someone"],
          shares: "1",
          excluded: false,
        },
      ]),
    );
    const [participant] = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.operationId, operationId));
    await expect(
      ctx.db.transaction((tx) => recordPayment(tx, operator.id, participant.id)),
    ).rejects.toThrow(PayoutLockedError);
  });

  it("refuses to pay an excluded participant", async () => {
    // An excluded participant's amount is pinned at "0.00" by recalculate, but
    // paying them anyway would still insert a payout_payment row -- making
    // hasPayments() true and freezing the operation permanently, since
    // assertEditable and unlockOperation both refuse forever once any payment
    // exists.
    const operator = await seedOperator();
    const { id: operationId } = await ctx.db.transaction((tx) =>
      createOperation(tx, operator.id, {
        name: "Has an excluded pilot",
        occurredAt: new Date(),
        corpSharePct: "0",
      }),
    );
    await ctx.db
      .insert(lootPool)
      .values({ operationId, valuationSource: "flat", totalValue: "100.00", notes: "n" });
    await ctx.db.transaction((tx) =>
      setRoster(tx, operator.id, operationId, [
        {
          displayName: "Excluded Pilot",
          accountId: null,
          recipientCharacterId: null,
          sourceCharacters: ["Excluded Pilot"],
          shares: "1",
          excluded: true,
        },
      ]),
    );
    const [participant] = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.operationId, operationId));
    await ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, operationId));
    await expect(
      ctx.db.transaction((tx) => recordPayment(tx, operator.id, participant.id)),
    ).rejects.toThrow(PayoutLockedError);
    const payments = await ctx.db
      .select()
      .from(payoutPayment)
      .where(eq(payoutPayment.participantId, participant.id));
    expect(payments).toHaveLength(0);
  });

  it("is idempotent: paying twice writes one payment row and doesn't move paidAmount", async () => {
    const { participantId, operator, operationId } =
      await seedFightWithOnePaidParticipant();
    await ctx.db.transaction((tx) => recordPayment(tx, operator.id, participantId));
    const payments = await ctx.db
      .select()
      .from(payoutPayment)
      .where(eq(payoutPayment.participantId, participantId));
    expect(payments).toHaveLength(1);
    void operationId;
  });

  /**
   * Two operators double-clicking "mark paid" at the same moment. Sequential
   * idempotence (the test above) does NOT cover this: if `paidAmount` is read
   * before the operation row lock, both transactions see null, then serialize,
   * then both insert — one payment event per click, for one payment.
   * `recordPayment` therefore locks first and re-reads the participant after.
   *
   * `vitest.config.ts` sets `fileParallelism: false`, but that is about test
   * FILES; two transactions inside one test still run concurrently against the
   * same Postgres, which is exactly what this needs.
   */
  it("two concurrent payments produce one payment row, not two", async () => {
    const { participantId, operator } = await seedFightWithOneUnpaidParticipant();

    const results = await Promise.allSettled([
      ctx.db.transaction((tx) => recordPayment(tx, operator.id, participantId)),
      ctx.db.transaction((tx) => recordPayment(tx, operator.id, participantId)),
    ]);
    // Both should succeed — the second is a no-op, not an error. If one rejects
    // with a serialization failure that is also acceptable behaviour, but the
    // row count below is the assertion that actually matters.
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);

    const payments = await ctx.db
      .select()
      .from(payoutPayment)
      .where(eq(payoutPayment.participantId, participantId));
    expect(payments).toHaveLength(1);

    const [participant] = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.id, participantId));
    expect(participant.paidAmount).toBe(payments[0].amount);
  });
});

describe("unlockOperation", () => {
  it("refuses once a payment exists", async () => {
    const { operationId, operator } = await seedFightWithOnePaidParticipant();
    await expect(
      ctx.db.transaction((tx) => unlockOperation(tx, operator.id, operationId)),
    ).rejects.toThrow(PayoutLockedError);
  });

  it("succeeds on a finalized operation with no payments", async () => {
    const operator = await seedOperator();
    const { id: operationId } = await ctx.db.transaction((tx) =>
      createOperation(tx, operator.id, {
        name: "Unpaid fight",
        occurredAt: new Date(),
        corpSharePct: "0",
      }),
    );
    await ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, operationId));
    await ctx.db.transaction((tx) => unlockOperation(tx, operator.id, operationId));
    const [op] = await ctx.db
      .select()
      .from(payoutOperation)
      .where(eq(payoutOperation.id, operationId));
    expect(op.status).toBe("draft");
  });

  it("refuses an operator who did not create the operation and is not an admin", async () => {
    const creator = await seedOperator();
    const other = await seedOperator();
    const { id: operationId } = await ctx.db.transaction((tx) =>
      createOperation(tx, creator.id, {
        name: "Someone else's fight",
        occurredAt: new Date(),
        corpSharePct: "0",
      }),
    );
    await ctx.db.transaction((tx) => finalizeOperation(tx, creator.id, operationId));
    await expect(
      ctx.db.transaction((tx) => unlockOperation(tx, other.id, operationId)),
    ).rejects.toThrow(PayoutForbiddenError);
  });

  /**
   * Authorization must be checked before payment state: an actor with no
   * right to unlock this operation must get PayoutForbiddenError, not
   * PayoutLockedError, even once money has moved — otherwise the error type
   * itself leaks whether the operation is paid to someone with no right to
   * know. This pins that precedence against a future reorder.
   */
  it("refuses a non-creator non-admin even when a payment exists", async () => {
    const { operationId, operator } = await seedFightWithOnePaidParticipant();
    const other = await seedOperator();
    await expect(
      ctx.db.transaction((tx) => unlockOperation(tx, other.id, operationId)),
    ).rejects.toThrow(PayoutForbiddenError);
    void operator;
  });

  it("allows an admin who did not create the operation", async () => {
    const creator = await seedOperator();
    const admin = await seedAccount(ctx.db, {
      tier: "flygd",
      status: "active",
      isAdmin: true,
    });
    const { id: operationId } = await ctx.db.transaction((tx) =>
      createOperation(tx, creator.id, {
        name: "Admin unlock",
        occurredAt: new Date(),
        corpSharePct: "0",
      }),
    );
    await ctx.db.transaction((tx) => finalizeOperation(tx, creator.id, operationId));
    await ctx.db.transaction((tx) => unlockOperation(tx, admin.id, operationId));
    const [op] = await ctx.db
      .select()
      .from(payoutOperation)
      .where(eq(payoutOperation.id, operationId));
    expect(op.status).toBe("draft");
  });
});

describe("finalization freezes the operation", () => {
  /**
   * Without this, finalizing means nothing: the numbers stay editable, and
   * `unlockOperation` has no job to do. `assertEditable` refuses on status, not
   * only on payments — see "Lifecycle" in the design doc.
   */
  it("rejects payout-affecting edits on a finalized, UNPAID operation", async () => {
    const operator = await seedOperator();
    const member = await seedAccount(ctx.db, { tier: "blue", status: "active" });
    const { id: operationId } = await ctx.db.transaction((tx) =>
      createOperation(tx, operator.id, {
        name: "Frozen fight",
        occurredAt: new Date(),
        corpSharePct: "0",
      }),
    );
    await ctx.db.transaction((tx) =>
      setRoster(tx, operator.id, operationId, [
        {
          accountId: member.id,
          recipientCharacterId: null,
          displayName: "Pilot",
          sourceCharacters: ["Pilot"],
          shares: "1.00",
          excluded: false,
        },
      ]),
    );
    await ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, operationId));
    const [participant] = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.operationId, operationId));

    await expect(
      ctx.db.transaction((tx) =>
        setParticipantShares(tx, operator.id, participant.id, "2"),
      ),
    ).rejects.toThrow(PayoutLockedError);
    await expect(
      ctx.db.transaction((tx) => setRoster(tx, operator.id, operationId, [])),
    ).rejects.toThrow(PayoutLockedError);

    // …and unlocking restores editability, which is the point of having it.
    await ctx.db.transaction((tx) => unlockOperation(tx, operator.id, operationId));
    await ctx.db.transaction((tx) =>
      setParticipantShares(tx, operator.id, participant.id, "2"),
    );
    const [after] = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.id, participant.id));
    expect(after.shares).toBe("2.00");
  });
});

describe("the service layer is the authorization boundary", () => {
  /**
   * Server actions gate themselves, but they are not the only possible caller,
   * and a gate in the action leaves a TOCTOU window: the tier could change
   * between the action's check and the transaction's write. Each mutation
   * re-checks inside its own transaction. If any of these stop throwing, the
   * guard was dropped from that function.
   *
   * All fifteen mutating exports are exercised here: createOperation, setRoster,
   * finalizeOperation, unlockOperation, setParticipantShares,
   * setParticipantExcluded, removeParticipant, recordPayment, addAppraisedPool,
   * deletePool, setCorpSharePct, revertPayment, addParticipant, setItemPrice.
   * addFlatPool is covered separately in payout-loot.test.ts.
   */
  it("rejects every mutation when the actor is not an active flygd account", async () => {
    const operator = await seedOperator();
    const green = await seedAccount(ctx.db, { tier: "green", status: "active" });
    const cryo = await seedAccount(ctx.db, { tier: "flygd", status: "cryo" });
    const { id: operationId } = await ctx.db.transaction((tx) =>
      createOperation(tx, operator.id, {
        name: "Guarded",
        occurredAt: new Date(),
        corpSharePct: "0",
      }),
    );
    await ctx.db.transaction((tx) =>
      setRoster(tx, operator.id, operationId, [
        {
          displayName: "Guarded Pilot",
          accountId: null,
          recipientCharacterId: null,
          sourceCharacters: ["Guarded Pilot"],
          shares: "1",
          excluded: false,
        },
      ]),
    );
    const [participant] = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.operationId, operationId));
    const { poolId } = await ctx.db.transaction((tx) =>
      addAppraisedPool(tx, operator.id, operationId, {
        rawPaste: "1x Tritanium",
        pricingMode: "sell_best",
        stationId: 60003760,
        appraisal: { items: [], totalValue: "0.00", dropped: [] },
      }),
    );
    const [loopItem] = await ctx.db
      .insert(lootItem)
      .values({
        poolId,
        typeId: 34,
        name: "Tritanium",
        qty: 1,
        unitPrice: "1.00",
        totalValue: "1.00",
        priceSource: "triff",
      })
      .returning();
    // Finalized (not draft) so the recordPayment case below tests the
    // authorization guard itself rather than the unrelated "operation must be
    // finalized before paying" PayoutLockedError a draft operation would throw
    // first if the guard were ever removed -- that error is real, but it is
    // not this test's signal, and a reader chasing a broken guard here would
    // be misled by it.
    await ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, operationId));

    for (const actor of [green.id, cryo.id]) {
      await expect(
        ctx.db.transaction((tx) =>
          createOperation(tx, actor, {
            name: "Nope",
            occurredAt: new Date(),
            corpSharePct: "0",
          }),
        ),
      ).rejects.toThrow(PayoutForbiddenError);
      await expect(
        ctx.db.transaction((tx) => setRoster(tx, actor, operationId, [])),
      ).rejects.toThrow(PayoutForbiddenError);
      await expect(
        ctx.db.transaction((tx) => setParticipantShares(tx, actor, participant.id, "2")),
      ).rejects.toThrow(PayoutForbiddenError);
      await expect(
        ctx.db.transaction((tx) =>
          setParticipantExcluded(tx, actor, participant.id, true),
        ),
      ).rejects.toThrow(PayoutForbiddenError);
      await expect(
        ctx.db.transaction((tx) => removeParticipant(tx, actor, participant.id)),
      ).rejects.toThrow(PayoutForbiddenError);
      await expect(
        ctx.db.transaction((tx) => recordPayment(tx, actor, participant.id)),
      ).rejects.toThrow(PayoutForbiddenError);
      await expect(
        ctx.db.transaction((tx) => revertPayment(tx, actor, participant.id)),
      ).rejects.toThrow(PayoutForbiddenError);
      await expect(
        ctx.db.transaction((tx) => setCorpSharePct(tx, actor, operationId, "10")),
      ).rejects.toThrow(PayoutForbiddenError);
      await expect(
        ctx.db.transaction((tx) =>
          addAppraisedPool(tx, actor, operationId, {
            rawPaste: "1x Tritanium",
            pricingMode: "sell_best",
            stationId: 60003760,
            appraisal: { items: [], totalValue: "0.00", dropped: [] },
          }),
        ),
      ).rejects.toThrow(PayoutForbiddenError);
      await expect(
        ctx.db.transaction((tx) => deletePool(tx, actor, poolId)),
      ).rejects.toThrow(PayoutForbiddenError);
      await expect(
        ctx.db.transaction((tx) => finalizeOperation(tx, actor, operationId)),
      ).rejects.toThrow(PayoutForbiddenError);
      await expect(
        ctx.db.transaction((tx) => unlockOperation(tx, actor, operationId)),
      ).rejects.toThrow(PayoutForbiddenError);
      await expect(
        ctx.db.transaction((tx) => addParticipant(tx, actor, operationId, "Nope")),
      ).rejects.toThrow(PayoutForbiddenError);
      await expect(
        ctx.db.transaction((tx) => setItemPrice(tx, actor, loopItem.id, "2.00")),
      ).rejects.toThrow(PayoutForbiddenError);
    }

    // Confirm none of the forbidden attempts actually mutated anything: the
    // participant is untouched and the pool is still there.
    const [stillThere] = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.id, participant.id));
    expect(stillThere.shares).toBe("1.00");
    expect(stillThere.excluded).toBe(false);
    const [poolStillThere] = await ctx.db
      .select()
      .from(lootPool)
      .where(eq(lootPool.id, poolId));
    expect(poolStillThere).toBeDefined();
  });
});

describe("PayoutNotFoundError", () => {
  /**
   * A bare Error here is indistinguishable from a programming mistake, so a
   * caller has to either swallow everything or nothing. These are the same
   * discriminable-failure contract PayoutForbiddenError and PayoutLockedError
   * already give callers.
   */
  const MISSING = "00000000-0000-0000-0000-000000000000";

  it("is thrown for a missing operation", async () => {
    const operator = await seedOperator();
    await expect(
      ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, MISSING)),
    ).rejects.toThrow(PayoutNotFoundError);
  });

  it("is thrown for a missing participant", async () => {
    const operator = await seedOperator();
    await expect(
      ctx.db.transaction((tx) => setParticipantShares(tx, operator.id, MISSING, "2")),
    ).rejects.toThrow(PayoutNotFoundError);
    await expect(
      ctx.db.transaction((tx) => recordPayment(tx, operator.id, MISSING)),
    ).rejects.toThrow(PayoutNotFoundError);
  });
});

describe("payment history is ordered as it happened", () => {
  /**
   * payout_payment.at defaults to now(), which is TRANSACTION START time. Two
   * writers serialize on the operation row lock, but a transaction that
   * started earlier can take the lock later and stamp an earlier time than an
   * event that actually happened first — so a fold or a display ordered by
   * `at` reads the sequence backwards.
   *
   * Inside ONE transaction now() is frozen, which is what makes this test
   * discriminate: under defaultNow() both rows carry the identical instant.
   * The reading taken after the lock does not.
   *
   * Scope, stated so this test is not read as more than it is: the two rows
   * here belong to DIFFERENT participants, so the clamp in `nextPaymentAt`
   * does not apply between them and the separation rests on the clock having
   * advanced between two round trips. The guaranteed, tie-free case is
   * per-participant, and Part B's pay -> revert -> pay test is the one that
   * pins it.
   *
   * The comparison is done in Postgres because `at` has microsecond
   * resolution and a JS Date does not — two inserts a few microseconds apart
   * would compare equal after truncation to milliseconds, making the
   * assertion pass or fail by luck.
   */
  it("stamps two payments in one transaction with strictly increasing at", async () => {
    const operator = await seedOperator();
    const { id: operationId } = await ctx.db.transaction((tx) =>
      createOperation(tx, operator.id, {
        name: "Two payees",
        occurredAt: new Date(),
        corpSharePct: "0",
      }),
    );
    await ctx.db.insert(lootPool).values({
      operationId,
      valuationSource: "flat",
      totalValue: "1000.00",
      notes: "sold privately",
    });
    await ctx.db.transaction((tx) =>
      setRoster(
        tx,
        operator.id,
        operationId,
        ["First Payee", "Second Payee"].map((displayName) => ({
          displayName,
          accountId: null,
          recipientCharacterId: null,
          sourceCharacters: [displayName],
          shares: "1",
          excluded: false,
        })),
      ),
    );
    await ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, operationId));
    const participants = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.operationId, operationId));
    const first = participants.find((p) => p.displayName === "First Payee")!;
    const second = participants.find((p) => p.displayName === "Second Payee")!;

    await ctx.db.transaction(async (tx) => {
      await recordPayment(tx, operator.id, first.id);
      await recordPayment(tx, operator.id, second.id);
    });

    const ids = [first.id, second.id];
    const [span] = await ctx.db
      .select({
        strictlyIncreasing: sql<boolean>`min(${payoutPayment.at}) < max(${payoutPayment.at})`,
      })
      .from(payoutPayment)
      .where(inArray(payoutPayment.participantId, ids));
    expect(span.strictlyIncreasing).toBe(true);

    // …and the order the page will render is the order the payments happened.
    const history = await ctx.db
      .select({ participantId: payoutPayment.participantId })
      .from(payoutPayment)
      .where(inArray(payoutPayment.participantId, ids))
      .orderBy(asc(payoutPayment.at), asc(payoutPayment.id));
    expect(history.map((h) => h.participantId)).toEqual([first.id, second.id]);
  });
});

describe("revertPayment", () => {
  it("clears paidAmount, appends a reverted row, and lets the participant be paid again", async () => {
    const { operationId, participantId, operator } =
      await seedFightWithOnePaidParticipant();

    await ctx.db.transaction((tx) => revertPayment(tx, operator.id, participantId));

    const [reverted] = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.id, participantId));
    expect(reverted.paidAmount).toBeNull();
    expect(reverted.amount).toBe("1000.00"); // what is owed did not change

    const history = await ctx.db
      .select()
      .from(payoutPayment)
      .where(eq(payoutPayment.participantId, participantId))
      .orderBy(asc(payoutPayment.at), asc(payoutPayment.id));
    expect(history.map((h) => h.kind)).toEqual(["paid", "reverted"]);
    expect(history[1].amount).toBe("1000.00");
    expect(history[1].actor).toBe(operator.id);

    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "payout.payment_reverted"));
    expect(audits).toHaveLength(1);
    expect(audits[0].target).toBe(operationId); // the operation uuid, not the participant

    // The whole point of clearing paidAmount: recordPayment's idempotence
    // check is `paidAmount !== null`, so a reverted participant is payable.
    await ctx.db.transaction((tx) => recordPayment(tx, operator.id, participantId));
    const [repaid] = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.id, participantId));
    expect(repaid.paidAmount).toBe("1000.00");
  });

  it("refuses a participant who is not currently paid", async () => {
    const { participantId, operator } = await seedFightWithOneUnpaidParticipant();
    await expect(
      ctx.db.transaction((tx) => revertPayment(tx, operator.id, participantId)),
    ).rejects.toThrow(PayoutLockedError);
  });

  it("refuses a draft operation", async () => {
    const { operationId, participantId, operator } =
      await seedFightWithOnePaidParticipant();
    // Reach draft without going through unlockOperation, which refuses once a
    // payment exists — this is testing revertPayment's own status guard.
    await ctx.db
      .update(payoutOperation)
      .set({ status: "draft" })
      .where(eq(payoutOperation.id, operationId));
    await expect(
      ctx.db.transaction((tx) => revertPayment(tx, operator.id, participantId)),
    ).rejects.toThrow(PayoutLockedError);
  });

  /**
   * The decision this test exists to pin: reverting corrects the record of who
   * was paid, it does NOT reopen the numbers. `hasPayments` counts every
   * payout_payment row regardless of kind, so the operation stays frozen
   * forever. A later change that makes hasPayments a fold has to argue with
   * this test rather than quietly enabling a paid operation's loot total to be
   * rewritten afterwards.
   */
  it("does not un-freeze the operation", async () => {
    const { operationId, participantId, operator } =
      await seedFightWithOnePaidParticipant();
    await ctx.db.transaction((tx) => revertPayment(tx, operator.id, participantId));

    // unlockOperation's refusal IS the hasPayments check, so this is the
    // assertion that proves the freeze survived rather than merely observing
    // that the operation is still `finalized`.
    await expect(
      ctx.db.transaction((tx) => unlockOperation(tx, operator.id, operationId)),
    ).rejects.toThrow(PayoutLockedError);
    await expect(
      ctx.db.transaction((tx) =>
        setParticipantShares(tx, operator.id, participantId, "2"),
      ),
    ).rejects.toThrow(PayoutLockedError);
  });

  it("leaves paidAmount null when recalculate runs after a revert", async () => {
    const { operationId, participantId, poolId, operator } =
      await seedFightWithOnePaidParticipant();
    await ctx.db.transaction((tx) => revertPayment(tx, operator.id, participantId));

    await ctx.db
      .update(lootPool)
      .set({ totalValue: "1200.00" })
      .where(eq(lootPool.id, poolId));
    await ctx.db.transaction((tx) => recalculate(tx, operationId));

    const [after] = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.id, participantId));
    expect(after.amount).toBe("1200.00"); // moved
    expect(after.paidAmount).toBeNull(); // recalculate writes ONLY amount
  });

  /**
   * Inside one transaction Postgres freezes `now()`, so under `defaultNow()`
   * all three rows would carry one identical instant. That is what makes this
   * a pin on the explicit stamp rather than a restatement of it.
   */
  it("pay -> revert -> pay in one transaction yields three distinct instants", async () => {
    const { participantId, operator } = await seedFightWithOneUnpaidParticipant();

    await ctx.db.transaction(async (tx) => {
      await recordPayment(tx, operator.id, participantId);
      await revertPayment(tx, operator.id, participantId);
      await recordPayment(tx, operator.id, participantId);
    });

    // Compared in SQL, deliberately. `at` is microsecond resolution and a JS
    // Date truncates to milliseconds, so three inserts microseconds apart read
    // as equal through `.getTime()` and the assertion would pass or fail by
    // luck. Under `defaultNow()` the distinct count here is 1, not 3.
    //
    // `instants === 3` is DETERMINISTIC, and it is the clamp in nextPaymentAt
    // that makes it so — not clock_timestamp() happening to tick between three
    // statements. A bare clock_timestamp() would make this assertion true on
    // most hosts and flaky on a coarse clock; the clamp forces each row at
    // least a microsecond past this participant's previous one, so it cannot
    // be otherwise.
    const res = await ctx.db.execute(sql`
      select count(*)::int as rows, count(distinct at)::int as instants
      from payout_payment
      where participant_id = ${participantId}`);
    const counts = res.rows[0] as { rows: number; instants: number };
    expect(counts.rows).toBe(3);
    expect(counts.instants).toBe(3);

    // Companion, not the discriminator: with three distinct instants the
    // ordering below is forced, but under defaultNow() the tie would fall back
    // to random-uuid order and land on the right sequence half the time.
    const history = await ctx.db
      .select()
      .from(payoutPayment)
      .where(eq(payoutPayment.participantId, participantId))
      .orderBy(asc(payoutPayment.at), asc(payoutPayment.id));
    expect(history.map((h) => h.kind)).toEqual(["paid", "reverted", "paid"]);
  });
});

describe("setParticipantShares bounds", () => {
  it("rejects a share count above the column's range with a readable error", async () => {
    const operator = await seedOperator();
    const { id: operationId } = await ctx.db.transaction((tx) =>
      createOperation(tx, operator.id, {
        name: "Big shares",
        occurredAt: new Date(),
        corpSharePct: "0",
      }),
    );
    await ctx.db.transaction((tx) =>
      setRoster(tx, operator.id, operationId, [
        {
          displayName: "Greedy Pilot",
          accountId: null,
          recipientCharacterId: null,
          sourceCharacters: ["Greedy Pilot"],
          shares: "1",
          excluded: false,
        },
      ]),
    );
    const [participant] = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.operationId, operationId));

    await expect(
      ctx.db.transaction((tx) =>
        setParticipantShares(tx, operator.id, participant.id, "10000"),
      ),
    ).rejects.toThrow(/9999\.99/);
    await expect(
      ctx.db.transaction((tx) =>
        setParticipantShares(tx, operator.id, participant.id, "0"),
      ),
    ).rejects.toThrow(/positive/);

    // 9999.99 is the largest the numeric(6,2) column holds, and must still be
    // accepted — the guard is a bound, not an off-by-one narrowing.
    await ctx.db.transaction((tx) =>
      setParticipantShares(tx, operator.id, participant.id, "9999.99"),
    );
    const [after] = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.id, participant.id));
    expect(after.shares).toBe("9999.99");
  });
});

describe("addParticipant", () => {
  async function seedDraftWithRoster(names: string[]) {
    const operator = await seedOperator();
    const { id: operationId } = await ctx.db.transaction((tx) =>
      createOperation(tx, operator.id, {
        name: "Manual entry",
        occurredAt: new Date(),
        corpSharePct: "0",
      }),
    );
    await ctx.db.insert(lootPool).values({
      operationId,
      valuationSource: "flat",
      totalValue: "300.00",
      notes: "sold privately",
    });
    if (names.length > 0) {
      const entries = await resolveRosterNames(ctx.db, names);
      await ctx.db.transaction((tx) => setRoster(tx, operator.id, operationId, entries));
    }
    return { operator, operationId };
  }

  it("adds a new unresolved name as its own participant and recalculates", async () => {
    const { operator, operationId } = await seedDraftWithRoster(["Pilot One"]);

    await ctx.db.transaction((tx) =>
      addParticipant(tx, operator.id, operationId, "Pilot Two"),
    );

    const rows = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.operationId, operationId));
    expect(rows).toHaveLength(2);
    // 300.00 over two equal shares — proof recalculate ran, not just that the
    // row landed.
    expect(rows.map((r) => r.amount).sort()).toEqual(["150.00", "150.00"]);
    const added = rows.find((r) => r.displayName === "Pilot Two")!;
    expect(added.accountId).toBeNull();
    expect(added.sourceCharacters).toEqual(["Pilot Two"]);
    expect(added.shares).toBe("1.00");

    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "payout.participant_added"));
    expect(audits).toHaveLength(1);
    expect(audits[0].target).toBe(operationId);
  });

  /**
   * The paste path collapses alts inside one paste via entryByAccountId. Manual
   * entry has to reproduce that against rows already in the table, or one human
   * pasted as their main and typed in as their alt draws two full shares.
   */
  it("collapses an alt into the existing participant rather than adding a second share", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, {
      id: 700001,
      accountId: acc.id,
      name: "Fleet Main",
      main: true,
    });
    await seedCharacter(ctx.db, cfg, {
      id: 700002,
      accountId: acc.id,
      name: "Fleet Alt",
    });
    const { operator, operationId } = await seedDraftWithRoster(["Fleet Main"]);

    await ctx.db.transaction((tx) =>
      addParticipant(tx, operator.id, operationId, "Fleet Alt"),
    );

    const rows = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.operationId, operationId));
    expect(rows).toHaveLength(1);
    expect(rows[0].displayName).toBe("Fleet Main");
    expect(rows[0].sourceCharacters).toEqual(["Fleet Main", "Fleet Alt"]);
    expect(rows[0].amount).toBe("300.00"); // one share, not two
  });

  it("rejects a case-insensitively duplicate unresolved name", async () => {
    const { operator, operationId } = await seedDraftWithRoster(["Pilot One"]);
    await expect(
      ctx.db.transaction((tx) =>
        addParticipant(tx, operator.id, operationId, "pilot one"),
      ),
    ).rejects.toThrow(/already on this roster/);
    const rows = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.operationId, operationId));
    expect(rows).toHaveLength(1);
  });

  it("refuses once the operation is finalized", async () => {
    const { operator, operationId } = await seedDraftWithRoster(["Pilot One"]);
    await ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, operationId));
    await expect(
      ctx.db.transaction((tx) =>
        addParticipant(tx, operator.id, operationId, "Latecomer"),
      ),
    ).rejects.toThrow(PayoutLockedError);
  });
});

/** A finalized operation with one participant who has a real recipient
 *  character. The roster is inserted directly rather than through `setRoster`
 *  so the fixture states the recipient outright — the only field under test. */
async function seedTargetableParticipant(
  opts: {
    excluded?: boolean;
    recipientCharacterId?: number | null;
    finalize?: boolean;
  } = {},
) {
  const operator = await seedOperator();
  if (opts.recipientCharacterId) {
    await seedCharacter(ctx.db, cfg, {
      id: opts.recipientCharacterId,
      accountId: operator.id,
    });
  }
  const { id: operationId } = await ctx.db.transaction((tx) =>
    createOperation(tx, operator.id, {
      name: "Friday roam",
      occurredAt: new Date(),
      corpSharePct: "0",
    }),
  );
  const [participant] = await ctx.db
    .insert(payoutParticipant)
    .values({
      operationId,
      displayName: "Line Member",
      recipientCharacterId: opts.recipientCharacterId ?? null,
      excluded: opts.excluded ?? false,
    })
    .returning();
  if (opts.finalize !== false) {
    await ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, operationId));
  }
  return { operator, operationId, participantId: participant.id };
}

describe("getOpenInfoTarget", () => {
  it("returns the STORED recipient character id", async () => {
    const { operationId, participantId } = await seedTargetableParticipant({
      recipientCharacterId: 510001,
    });
    expect(await getOpenInfoTarget(ctx.db, operationId, participantId)).toBe(510001);
  });

  it("refuses a participant belonging to a DIFFERENT operation", async () => {
    // The attack this whole helper exists to stop: an operator may operate
    // payouts, which says nothing about whose window they may open. Without
    // the operation/participant join the operation id would be decoration.
    const mine = await seedTargetableParticipant({ recipientCharacterId: 510002 });
    const theirs = await seedTargetableParticipant({ recipientCharacterId: 510003 });
    expect(
      await getOpenInfoTarget(ctx.db, mine.operationId, theirs.participantId),
    ).toBeNull();
  });

  it("refuses a participant on an operation that is still a draft", async () => {
    const { operationId, participantId } = await seedTargetableParticipant({
      recipientCharacterId: 510004,
      finalize: false,
    });
    expect(await getOpenInfoTarget(ctx.db, operationId, participantId)).toBeNull();
  });

  it("refuses an excluded participant", async () => {
    const { operationId, participantId } = await seedTargetableParticipant({
      recipientCharacterId: 510005,
      excluded: true,
    });
    expect(await getOpenInfoTarget(ctx.db, operationId, participantId)).toBeNull();
  });

  it("returns null for an unresolved roster name with no recipient", async () => {
    const { operationId, participantId } = await seedTargetableParticipant();
    expect(await getOpenInfoTarget(ctx.db, operationId, participantId)).toBeNull();
  });

  it("returns null for a participant id that does not exist", async () => {
    const { operationId } = await seedTargetableParticipant({
      recipientCharacterId: 510006,
    });
    expect(
      await getOpenInfoTarget(
        ctx.db,
        operationId,
        "00000000-0000-0000-0000-000000000000",
      ),
    ).toBeNull();
  });
});
