import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import type { Dbx } from "@/db";
import { oauthTransaction, type oauthIntentEnum } from "@/db/schema";

const TTL_MS = 10 * 60 * 1000;

const sha256b64u = (s: string) => createHash("sha256").update(s).digest("base64url");

type OauthIntent = (typeof oauthIntentEnum.enumValues)[number];

type FleetReadContext = {
  sessionId: string;
  accountId: string;
  fleetReadCharacterId: number;
};

// Stored rows are nullable for old intents; validate before any grant dispatch,
// not merely at creation, so malformed state can never become generic linking.
export function hasFleetReadContext(input: {
  sessionId?: string | null;
  accountId?: string | null;
  fleetReadCharacterId?: number | null;
}): input is FleetReadContext {
  return (
    typeof input.sessionId === "string" &&
    input.sessionId.length > 0 &&
    typeof input.accountId === "string" &&
    input.accountId.length > 0 &&
    typeof input.fleetReadCharacterId === "number" &&
    Number.isSafeInteger(input.fleetReadCharacterId) &&
    input.fleetReadCharacterId > 0
  );
}

export async function createOauthTransaction(
  dbx: Dbx,
  input:
    | ({ intent: "grant-fleet-read" } & FleetReadContext)
    | {
        intent: Exclude<OauthIntent, "grant-fleet-read">;
        sessionId?: string;
        accountId?: string;
        fleetReadCharacterId?: never;
      },
) {
  if (input.intent === "grant-fleet-read" && !hasFleetReadContext(input)) {
    throw new Error("Invalid Fleet Read context");
  }
  const state = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  await dbx.insert(oauthTransaction).values({
    stateHash: sha256b64u(state),
    intent: input.intent,
    sessionId: input.sessionId ?? null,
    accountId: input.accountId ?? null,
    fleetReadCharacterId:
      input.intent === "grant-fleet-read" ? input.fleetReadCharacterId : null,
    pkceVerifier: codeVerifier,
    expiresAt: new Date(Date.now() + TTL_MS),
  });
  return { state, codeVerifier, codeChallenge: sha256b64u(codeVerifier) };
}

export async function consumeOauthTransaction(
  dbx: Dbx,
  state: string,
  expectedIntents: OauthIntent[],
) {
  const rows = await dbx
    .update(oauthTransaction)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(oauthTransaction.stateHash, sha256b64u(state)),
        inArray(oauthTransaction.intent, expectedIntents),
        isNull(oauthTransaction.consumedAt),
        gt(oauthTransaction.expiresAt, new Date()),
      ),
    )
    .returning();
  const row = rows[0];
  if (!row) return null;
  return {
    intent: row.intent,
    sessionId: row.sessionId,
    accountId: row.accountId,
    fleetReadCharacterId: row.fleetReadCharacterId,
    pkceVerifier: row.pkceVerifier,
  };
}
