import { randomUUID } from "node:crypto";
import { createRemoteJWKSet, customFetch } from "jose";
import { asc, eq, inArray, sql } from "drizzle-orm";
import type { Config } from "@/config";
import type { Db, Dbx } from "@/db";
import { account, character } from "@/db/schema";
import type { RecruitmentExport } from "@/core/recruitment-evidence";
import { EveSsoError, verifyEveAccessToken } from "@/lib/esi/sso";
import {
  createRecruitmentCollector,
  type RecruitmentCharacterInput,
  type RecruitmentLimits,
} from "@/lib/esi/recruitment";
import { getFreshAccessToken } from "@/services/tokens";
import { getSessionAccount } from "@/services/session";
import { logAudit } from "@/services/audit";

export class RecruitmentCollectionError extends Error {
  constructor(
    readonly code:
      "not_authorized" | "not_found" | "identity_changed" | "collection_failed",
  ) {
    super(code);
  }
}
export type RecruitmentCollectionInput = {
  actorAccountId: string;
  sessionId: string;
  targetAccountId: string;
};
export type RecruitmentCollectionDeps = {
  fetchImpl?: typeof fetch;
  verifyAccessToken?: typeof verifyEveAccessToken;
  now?: () => number;
  limits?: Partial<RecruitmentLimits>;
  /** Internal/test override: may only reduce the 10-second statement bound. */
  dbTimeoutMs?: number;
};

async function requireAdmin(
  db: Dbx,
  input: RecruitmentCollectionInput,
  forUpdate = false,
) {
  const actor = await getSessionAccount(db, input.sessionId, { forUpdate });
  const [row] = await db
    .select({ isAdmin: account.isAdmin })
    .from(account)
    .where(eq(account.id, input.actorAccountId));
  if (actor?.accountId !== input.actorAccountId || !row?.isAdmin)
    throw new RecruitmentCollectionError("not_authorized");
}
const linkedCharacters = (db: Dbx, targetAccountId: string) =>
  db
    .select()
    .from(character)
    .where(eq(character.accountId, targetAccountId))
    .orderBy(asc(character.id));

/**
 * One-time request collection, intentionally not a persisted worker job. A lost
 * request must be collected again; resumability would require an evidence archive.
 * Token rotation keeps its existing encrypted CAS path.
 */
export async function collectRecruitmentEvidence(
  db: Db,
  cfg: Config,
  input: RecruitmentCollectionInput,
  deps: RecruitmentCollectionDeps = {},
): Promise<RecruitmentExport> {
  const now = deps.now ?? Date.now;
  const snapshotId = randomUUID();
  const collectedAt = new Date(now()).toISOString();
  let authorised = false;
  const dbTimeoutMs = deps.dbTimeoutMs ?? 10_000;
  const boundDatabase = async (tx: Dbx) => {
    await tx.execute(
      sql.raw(`set local lock_timeout = '${Math.min(dbTimeoutMs, 5000)}ms'`),
    );
    await tx.execute(sql.raw(`set local statement_timeout = '${dbTimeoutMs}ms'`));
  };
  try {
    if (!Number.isSafeInteger(dbTimeoutMs) || dbTimeoutMs < 1 || dbTimeoutMs > 10_000)
      throw new RecruitmentCollectionError("collection_failed");
    const collector = createRecruitmentCollector({
      fetchImpl: deps.fetchImpl,
      now,
      limits: deps.limits,
      userAgent: `authGD recruitment evidence (${cfg.esiContact}; ${cfg.appBaseUrl})`,
    });
    // Snapshot-local cache: jose's default global resolver fetches/decodes JWKS
    // outside our quotas. customFetch bounds that body before jose parses it.
    const getKey = createRemoteJWKSet(new URL("https://login.eveonline.com/oauth/jwks"), {
      [customFetch]: collector.boundedFetch,
    });
    const refreshFetch: typeof fetch = async (url, init) => {
      const response = await collector.boundedFetch(url, init);
      if (response.ok) return response;
      // getFreshAccessToken audits OAuth error codes. Do not pass arbitrary
      // upstream error text into that existing persistence path.
      const body: unknown = await response.json().catch(() => null);
      const code =
        body !== null && typeof body === "object" && "error" in body
          ? body.error
          : undefined;
      const safeCode =
        typeof code === "string" &&
        [
          "invalid_grant",
          "invalid_token",
          "unauthorized_client",
          "access_denied",
          "temporarily_unavailable",
          "server_error",
        ].includes(code)
          ? code
          : undefined;
      throw new EveSsoError("Recruitment token refresh failed", {
        status: response.status,
        oauthError: safeCode,
      });
    };
    // One consistent captured set; no network I/O or retained locks from this tx.
    const captured = await db.transaction(
      async (tx) => {
        await boundDatabase(tx);
        await requireAdmin(tx, input);
        const [target] = await tx
          .select({ id: account.id })
          .from(account)
          .where(eq(account.id, input.targetAccountId));
        if (!target) throw new RecruitmentCollectionError("not_found");
        return linkedCharacters(tx, input.targetAccountId);
      },
      { isolationLevel: "repeatable read" },
    );
    authorised = true;
    // The existing review manifest requires at least one included character.
    if (captured.length === 0) throw new RecruitmentCollectionError("collection_failed");
    const ids = captured.map((ch) => String(ch.id));
    const result: RecruitmentExport = {
      format: "authgd-recruitment-evidence",
      version: 1,
      accountId: input.targetAccountId,
      manifest: {
        version: 1,
        bundleId: snapshotId,
        revision: "r1",
        collectedAt,
        declaredCharacterIds: ids,
        includedCharacterIds: [...ids],
        provenance: [],
        datasets: [],
      },
      records: [],
    };
    for (const ch of captured) {
      const subject: RecruitmentCharacterInput = {
        characterId: ch.id,
        name: ch.name,
        unavailableStatus: "failed",
      };
      const token = await getFreshAccessToken(db, cfg, ch, refreshFetch, dbTimeoutMs);
      if (token.ok) {
        let identity: Awaited<ReturnType<typeof verifyEveAccessToken>> | undefined;
        try {
          identity = await collector.withinBudget(() =>
            (deps.verifyAccessToken ?? verifyEveAccessToken)(token.accessToken, getKey),
          );
        } catch {
          // Unverifiable is unknown, never an empty/authorised private dataset.
          // Do not emit the JWT verifier's messages (they can contain claims).
        }
        if (identity) {
          if (identity.characterId !== ch.id || identity.ownerHash !== ch.ownerHash)
            throw new RecruitmentCollectionError("identity_changed");
          subject.accessToken = token.accessToken;
          subject.scopes = identity.scopes;
          subject.name = identity.characterName;
          subject.unavailableStatus = "unauthorised";
        }
      } else {
        subject.unavailableStatus =
          token.reason === "no_token" || token.reason === "invalid"
            ? "unauthorised"
            : "failed";
      }
      const evidence = await collector.collectCharacter(subject);
      result.manifest.datasets.push(...evidence.datasets);
      result.manifest.provenance.push(...evidence.provenance);
      result.records.push(...evidence.records);
    }
    // Short release transaction only, in lifecycle order: characters, sorted
    // accounts, session. Account FOR UPDATE also fences new character inserts
    // through the FK. Re-read the ENTIRE set, not merely the captured IDs.
    await db.transaction(async (tx) => {
      await boundDatabase(tx);
      await tx
        .select({ id: character.id })
        .from(character)
        .where(
          inArray(
            character.id,
            captured.map((ch) => ch.id),
          ),
        )
        .orderBy(asc(character.id))
        .for("share");
      const accounts = await tx
        .select({ id: account.id })
        .from(account)
        .where(
          inArray(
            account.id,
            [...new Set([input.actorAccountId, input.targetAccountId])].sort(),
          ),
        )
        .orderBy(asc(account.id))
        .for("update");
      await requireAdmin(tx, input, true);
      if (!accounts.some((row) => row.id === input.targetAccountId))
        throw new RecruitmentCollectionError("identity_changed");
      const current = await linkedCharacters(tx, input.targetAccountId);
      if (
        current.length !== captured.length ||
        current.some((ch, index) => {
          const old = captured[index];
          return (
            ch.id !== old.id ||
            ch.accountId !== old.accountId ||
            ch.ownerHash !== old.ownerHash ||
            ch.fleetLinkEpoch !== old.fleetLinkEpoch
          );
        })
      )
        throw new RecruitmentCollectionError("identity_changed");
      const coverage: Record<string, number> = {};
      for (const dataset of result.manifest.datasets)
        coverage[dataset.status] = (coverage[dataset.status] ?? 0) + 1;
      await logAudit(tx, {
        actor: input.actorAccountId,
        action: "recruitment.collected",
        target: input.targetAccountId,
        details: {
          snapshotId,
          collectedAt,
          characterCount: captured.length,
          outcome: result.manifest.datasets.every(
            (d) => d.status === "complete" || d.status === "empty",
          )
            ? "complete"
            : "partial",
          coverage,
        },
      });
    });
    return result;
  } catch (error) {
    const safe =
      error instanceof RecruitmentCollectionError
        ? error
        : new RecruitmentCollectionError("collection_failed");
    if (authorised) {
      try {
        await db.transaction(async (tx) => {
          await boundDatabase(tx);
          await logAudit(tx, {
            actor: input.actorAccountId,
            action: "recruitment.failed",
            target: input.targetAccountId,
            details: { snapshotId, collectedAt, outcome: safe.code },
          });
        });
      } catch {
        // Failure to record metadata must not replace the safe boundary error.
      }
    }
    throw safe;
  }
}
