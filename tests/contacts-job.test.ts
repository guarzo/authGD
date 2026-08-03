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

  it("still deletes stale contacts when addContacts permanently fails on another id", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
    await seedCharacter(ctx.db, cfg, { id: 2, accountId: acc.id });
    const { esi, calls } = fakeEsi({
      contacts: {
        1: [labeled(99)], // ours, no longer desired → delete
      },
    });
    const failingEsi: ContactsEsi = {
      ...esi,
      addContacts: async () => {
        throw new EsiError("invalid contact id", 400, "permanent");
      },
    };
    const result = await runContactsJob({ db: ctx.db, cfg, esi: failingEsi, fetchImpl: okToken });
    expect(result.status).toBe("partial");
    expect(result.counts?.failed).toBeGreaterThan(0);
    // the add failed permanently, but the delete still ran
    expect(calls.deletes).toContainEqual({ characterId: 1, ids: [99] });
    expect((await lastResult(1))?.lastResult).toBe("sync_failed");
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
