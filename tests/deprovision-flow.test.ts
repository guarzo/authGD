import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { auditLog, wandererAclObservation } from "@/db/schema";
import type { DiscordClient } from "@/lib/discord/rest";
import type { Affiliation } from "@/lib/esi/client";
import type { WandererAclMember, WandererClient } from "@/lib/wanderer/client";
import { dispatchOutbox } from "@/worker/dispatcher";
import { buildJobHandlers, type JobDeps } from "@/worker/handlers";
import { setupTestDb, truncateAll } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";

const cfg = testConfig();
const LABEL_ID = 77;

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

const okToken = (async () =>
  new Response(JSON.stringify({ access_token: "at", refresh_token: "rt2" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;

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
            {
              contactId: 10,
              contactType: "character",
              standing: 5,
              labelIds: [LABEL_ID],
            },
            {
              contactId: 11,
              contactType: "character",
              standing: 5,
              labelIds: [LABEL_ID],
            },
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
  let aclMembers: WandererAclMember[] = [
    { characterId: 10, role: "viewer" },
    { characterId: 11, role: "viewer" },
    { characterId: 20, role: "viewer" },
  ];
  const wanderer: WandererClient = {
    getAclMembers: async () => [...aclMembers],
    addAclMember: async (id) => {
      aclMembers.push({ characterId: id, role: "viewer" });
    },
    updateAclMemberRole: async (id, role) => {
      aclMembers = aclMembers.map((m) => (m.characterId === id ? { ...m, role } : m));
    },
    removeAclMember: async (id) => {
      aclMembers = aclMembers.filter((m) => m.characterId !== id);
    },
  };

  // Discord: both users currently carry the FlyGD role.
  const MANAGE_ROLES = String(1 << 28);
  const roleOps = {
    added: [] as Array<[string, string]>,
    removed: [] as Array<[string, string]>,
  };
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
  expect(dispatched).toBe(1); // exactly one demoted account
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
  expect(roleOps.removed).not.toContainEqual(["u-stayer", "10"]);

  // 7) Audit trail: demotion cause + downstream actions all recorded.
  const audits = await ctx.db.select().from(auditLog);
  const tierChange = audits.find((a) => a.action === "tier.changed");
  expect(tierChange?.details).toMatchObject({ to: "green", cause: "main left alliance" });
  expect(audits.filter((a) => a.action === "wanderer.removed")).toHaveLength(2);
  expect(audits.some((a) => a.action === "discord.role_changed")).toBe(true);

  // 8) Fail-closed routing: garbage payloads reject instead of running a job.
  await expect(handlers["membership"]({ garbage: true })).rejects.toThrow();
});
