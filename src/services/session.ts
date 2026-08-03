import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { Dbx } from "@/db";
import { account, session } from "@/db/schema";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/** Sessions are stored as SHA-256 digests: a leaked DB row cannot be replayed
 * as a cookie. The raw id lives only in the client's cookie. */
function sessionKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("base64url");
}

export async function createSession(dbx: Dbx, accountId: string): Promise<string> {
  const id = randomBytes(32).toString("base64url");
  await dbx.insert(session).values({
    id: sessionKey(id),
    accountId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  await dbx
    .update(account)
    .set({ lastLoginAt: new Date() })
    .where(eq(account.id, accountId));
  return id;
}

export async function getSessionAccount(
  dbx: Dbx,
  sessionId: string,
): Promise<{ accountId: string } | null> {
  const key = sessionKey(sessionId);
  const rows = await dbx
    .select()
    .from(session)
    .where(and(eq(session.id, key), gt(session.expiresAt, new Date())));
  const row = rows[0];
  if (!row) return null;
  if (Date.now() - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await dbx.update(session).set({ lastSeenAt: new Date() }).where(eq(session.id, key));
  }
  return { accountId: row.accountId };
}

export async function revokeAccountSessions(dbx: Dbx, accountId: string): Promise<void> {
  await dbx.delete(session).where(eq(session.accountId, accountId));
}
