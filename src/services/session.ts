import { randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { Dbx } from "@/db";
import { account, session } from "@/db/schema";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export async function createSession(dbx: Dbx, accountId: string): Promise<string> {
  const id = randomBytes(32).toString("base64url");
  await dbx.insert(session).values({
    id,
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
  const rows = await dbx
    .select()
    .from(session)
    .where(and(eq(session.id, sessionId), gt(session.expiresAt, new Date())));
  const row = rows[0];
  if (!row) return null;
  if (Date.now() - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await dbx
      .update(session)
      .set({ lastSeenAt: new Date() })
      .where(eq(session.id, sessionId));
  }
  return { accountId: row.accountId };
}

export async function revokeAccountSessions(
  dbx: Dbx,
  accountId: string,
): Promise<void> {
  await dbx.delete(session).where(eq(session.accountId, accountId));
}
