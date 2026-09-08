import { z } from "zod";
import type { Config } from "@/config";
import type { Db } from "@/db";
import { runAccessListsJob } from "@/jobs/access-lists";
import { runContactsJob, type ContactsEsi } from "@/jobs/contacts";
import { runDiscordRolesJob } from "@/jobs/discord-roles";
import { runLocationJob, type LocationEsi } from "@/jobs/location";
import { runMembershipJob } from "@/jobs/membership";
import { runPurgeJob } from "@/jobs/purge";
import { runStructureEventsJob } from "@/jobs/structure-events";
import { runStructuresJob } from "@/jobs/structures";
import { runTokenHealthJob } from "@/jobs/token-health";
import { runWandererJob } from "@/jobs/wanderer";
import type { DiscordClient } from "@/lib/discord/rest";
import type {
  AccessListsEsi,
  EsiClient,
  StructureEventsEsi,
  StructuresEsi,
} from "@/lib/esi/client";
import type { WandererClient } from "@/lib/wanderer/client";
import { QUEUES } from "@/worker/queues";
import {
  runFleetSourceJob,
  createFleetSourceMemory,
  type FleetSourceDeps,
} from "@/jobs/fleet-source";

// Fail closed: every payload must carry the queue's literal jobType and no
// unknown fields — garbage never triggers a job. Ordinary queues retry and
// surface via the dead-letter alert; source jobs have neither generic retries
// nor DLQ.
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
const accessListsSchema = z.object({ jobType: z.literal(QUEUES.accessLists) }).strict();
const structuresSchema = z.object({ jobType: z.literal(QUEUES.structures) }).strict();
const structureEventsSchema = z
  .object({ jobType: z.literal(QUEUES.structureEvents) })
  .strict();

export type JobDeps = {
  db: Db;
  cfg: Config;
  esi: Pick<EsiClient, "postAffiliation"> &
    ContactsEsi &
    LocationEsi &
    AccessListsEsi &
    StructuresEsi &
    StructureEventsEsi;
  wanderer: WandererClient;
  discord: DiscordClient;
  fetchImpl?: typeof fetch;
  fleetSource?: Pick<FleetSourceDeps, "getKey" | "now" | "memory" | "signal" | "esi">;
};

/**
 * One handler per job queue: parse the payload (fail closed — an unparseable
 * payload throws; ordinary jobs retry into the dead-letter alert, source jobs
 * do not) and run the job. The worker registers these with boss.work; tests drive
 * them directly with dispatcher-emitted payloads, so routing and parsing stay covered.
 */
export function buildJobHandlers(
  deps: JobDeps,
): Record<string, (data: unknown) => Promise<void>> {
  const memory = deps.fleetSource?.memory ?? createFleetSourceMemory();
  return {
    [QUEUES.fleetSource]: async (data) => {
      const parsed = z
        .object({
          jobType: z.literal("fleet-source"),
          sourceId: z.uuid(),
          generation: z.number().int().positive().max(2_147_483_646),
        })
        .strict()
        .safeParse(data);
      if (!parsed.success) throw new Error("fleet_source_payload_invalid");
      await runFleetSourceJob(
        {
          db: deps.db,
          cfg: deps.cfg,
          fetchImpl: deps.fetchImpl,
          ...deps.fleetSource,
          memory,
        },
        parsed.data,
      );
    },
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
    [QUEUES.accessLists]: async (data) => {
      accessListsSchema.parse(data);
      await runAccessListsJob(deps);
    },
    [QUEUES.structures]: async (data) => {
      structuresSchema.parse(data);
      await runStructuresJob(deps);
    },
    [QUEUES.structureEvents]: async (data) => {
      structureEventsSchema.parse(data);
      await runStructureEventsJob(deps);
    },
  };
}
