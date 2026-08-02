import type { Dbx } from "@/db";
import { auditLog } from "@/db/schema";

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
