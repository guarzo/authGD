import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import type { Dbx } from "@/db";
import { oauthTransaction } from "@/db/schema";

const TTL_MS = 10 * 60 * 1000;

const sha256b64u = (s: string) => createHash("sha256").update(s).digest("base64url");

export async function createOauthTransaction(
  dbx: Dbx,
  input: {
    intent: "login" | "link-character" | "link-discord";
    sessionId?: string;
    accountId?: string;
  },
) {
  const state = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  await dbx.insert(oauthTransaction).values({
    stateHash: sha256b64u(state),
    intent: input.intent,
    sessionId: input.sessionId ?? null,
    accountId: input.accountId ?? null,
    pkceVerifier: codeVerifier,
    expiresAt: new Date(Date.now() + TTL_MS),
  });
  return { state, codeVerifier, codeChallenge: sha256b64u(codeVerifier) };
}

export async function consumeOauthTransaction(
  dbx: Dbx,
  state: string,
  expectedIntents: Array<"login" | "link-character" | "link-discord">,
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
    pkceVerifier: row.pkceVerifier,
  };
}
