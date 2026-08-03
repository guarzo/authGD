import type { Dbx } from "@/db";
import { auditLog } from "@/db/schema";
import { and, desc, eq, like, lt } from "drizzle-orm";

export async function logAudit(
  dbx: Dbx,
  entry: {
    actor: string;
    action: string;
    target: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await dbx.insert(auditLog).values(entry);
}

export async function queryAuditLog(
  dbx: Dbx,
  filters: {
    actor?: string;
    action?: string; // prefix match, e.g. "tier."
    target?: string;
    beforeId?: number;
    limit?: number;
  } = {},
): Promise<Array<typeof auditLog.$inferSelect>> {
  const conds = [];
  if (filters.actor) conds.push(eq(auditLog.actor, filters.actor));
  if (filters.action) {
    // The filter is a LITERAL prefix; % and _ are LIKE wildcards, so escape
    // them (and backslash, Postgres's default escape character).
    const prefix = filters.action.replace(/[\\%_]/g, (c) => `\\${c}`);
    conds.push(like(auditLog.action, `${prefix}%`));
  }
  if (filters.target) conds.push(eq(auditLog.target, filters.target));
  if (filters.beforeId !== undefined) conds.push(lt(auditLog.id, filters.beforeId));
  const limit = Math.min(filters.limit ?? 100, 100);
  return dbx
    .select()
    .from(auditLog)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(auditLog.id))
    .limit(limit);
}
