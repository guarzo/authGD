import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "@/config";
import { lootPool, payoutOperation, payoutParticipant, payoutPayment } from "@/db/schema";
import { unlinkCharacter } from "@/services/accounts";
import { addAppraisedPool, deletePool } from "@/services/payout-loot";
import {
  PayoutForbiddenError,
  PayoutLockedError,
  canReadPayouts,
  createOperation,
  finalizeOperation,
  recalculate,
  recordPayment,
  removeParticipant,
  requirePayoutOperator,
  resolveRosterNames,
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
      .from((await import("@/db/schema")).payoutOperation)
      .where(eq((await import("@/db/schema")).payoutOperation.id, operationId));
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
   * All eleven mutating exports are exercised here: createOperation, setRoster,
   * finalizeOperation, unlockOperation, setParticipantShares,
   * setParticipantExcluded, removeParticipant, recordPayment, addAppraisedPool,
   * deletePool. addFlatPool is covered separately in payout-loot.test.ts.
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
        appraisal: { items: [], totalValue: "0.00" },
      }),
    );

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
        ctx.db.transaction((tx) =>
          addAppraisedPool(tx, actor, operationId, {
            rawPaste: "1x Tritanium",
            pricingMode: "sell_best",
            appraisal: { items: [], totalValue: "0.00" },
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
