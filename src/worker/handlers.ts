import { z } from "zod";
import type { Config } from "@/config";
import type { Db } from "@/db";
import { runContactsJob, type ContactsEsi } from "@/jobs/contacts";
import { runDiscordRolesJob } from "@/jobs/discord-roles";
import { runLocationJob, type LocationEsi } from "@/jobs/location";
import { runMembershipJob } from "@/jobs/membership";
import { runPurgeJob } from "@/jobs/purge";
import { runTokenHealthJob } from "@/jobs/token-health";
import { runWandererJob } from "@/jobs/wanderer";
import type { DiscordClient } from "@/lib/discord/rest";
import type { EsiClient } from "@/lib/esi/client";
import type { WandererClient } from "@/lib/wanderer/client";
import { QUEUES } from "@/worker/queues";

// Fail closed: every payload must carry the queue's literal jobType and no
// unknown fields — garbage never triggers a job (it rejects, retries, and
// surfaces via the dead-letter alert).
const membershipSchema = z
  .object({
    jobType: z.literal(QUEUES.membership),
    accountId: z.string().uuid().optional(),
  })
  .strict();
const membershipRecheckSchema = z
  .object({ jobType: z.literal(QUEUES.membershipRecheck) })
  .strict();
const contactsSchema = z.object({ jobType: z.literal(QUEUES.contacts) }).strict();
const wandererSchema = z.object({ jobType: z.literal(QUEUES.wanderer) }).strict();
const discordSchema = z
  .object({
    jobType: z.literal(QUEUES.discordRoles),
    accountId: z.string().uuid().optional(),
    discordUserId: z.string().optional(),
  })
  .strict();
const tokenHealthSchema = z.object({ jobType: z.literal(QUEUES.tokenHealth) }).strict();
const purgeSchema = z.object({ jobType: z.literal(QUEUES.purge) }).strict();
const locationSchema = z.object({ jobType: z.literal(QUEUES.location) }).strict();

export type JobDeps = {
  db: Db;
  cfg: Config;
  esi: Pick<EsiClient, "postAffiliation"> & ContactsEsi & LocationEsi;
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
      const { accountId } = membershipSchema.parse(data);
      await runMembershipJob(deps, { accountId });
    },
    [QUEUES.membershipRecheck]: async (data) => {
      membershipRecheckSchema.parse(data);
      await runMembershipJob(deps, { recheckInvalid: true });
    },
    [QUEUES.contacts]: async (data) => {
      contactsSchema.parse(data);
      await runContactsJob(deps);
    },
    [QUEUES.wanderer]: async (data) => {
      wandererSchema.parse(data);
      await runWandererJob(deps);
    },
    [QUEUES.discordRoles]: async (data) => {
      const { accountId, discordUserId } = discordSchema.parse(data);
      await runDiscordRolesJob(deps, { accountId, discordUserId });
    },
    [QUEUES.tokenHealth]: async (data) => {
      tokenHealthSchema.parse(data);
      await runTokenHealthJob(deps);
    },
    [QUEUES.purge]: async (data) => {
      purgeSchema.parse(data);
      await runPurgeJob(deps);
    },
    [QUEUES.location]: async (data) => {
      locationSchema.parse(data);
      await runLocationJob(deps);
    },
  };
}
