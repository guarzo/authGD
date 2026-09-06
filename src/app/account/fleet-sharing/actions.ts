"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import type { FleetAccessCheck } from "@/core/fleet-access";
import { loginErrorUrl } from "@/lib/error-redirects";
import { getSessionAccount } from "@/services/session";
import { checkFleetAccess } from "@/services/fleet-access";

const anchorSchema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));

export async function checkFleetAccessAction(
  _previous: FleetAccessCheck | null,
  formData: FormData,
): Promise<FleetAccessCheck> {
  const cfg = getConfig();
  const db = getDb();
  const sid = (await cookies()).get(cfg.sessionCookieName)?.value;
  const sess = sid ? await getSessionAccount(db, sid) : null;
  if (!sess) redirect(loginErrorUrl("session_expired"));

  // Authenticate before parsing. Neither previous state nor form account fields
  // are evidence; the service rechecks current ownership and Member tier.
  const anchor = anchorSchema.safeParse(formData.get("anchorCharacterId"));
  if (!anchor.success)
    return { code: "not_authorized", checkedAt: null, retryAt: null, characters: [] };
  return checkFleetAccess(db, cfg, {
    accountId: sess.accountId,
    anchorCharacterId: anchor.data,
  });
}
