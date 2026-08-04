"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { appraiseLoot } from "@/services/appraisal";
import { addAppraisedPool, addFlatPool, deletePool } from "@/services/payout-loot";
import {
  createOperation,
  finalizeOperation,
  recordPayment,
  removeParticipant,
  requirePayoutOperator,
  resolveRosterNames,
  setParticipantExcluded,
  setParticipantShares,
  setRoster,
  unlockOperation,
} from "@/services/payouts";
import { getSessionAccount } from "@/services/session";
import { createEsiClient } from "@/lib/esi/client";
import { createTriffClient, TriffError } from "@/lib/triff/client";
import { PRICING_MODES, type PricingMode } from "@/core/pricing";
import { parseRosterPaste } from "@/core/roster-paste";

/** FormData.get() is string | File | null; a File coerced with String() would
 *  stringify to "[object File]" rather than fail loudly, so every text field
 *  goes through this instead of `String(formData.get(name) ?? "")`. */
function field(formData: FormData, name: string): string {
  const raw = formData.get(name);
  return typeof raw === "string" ? raw : "";
}

async function requireOperatorAccount(): Promise<string> {
  const cfg = getConfig();
  const sid = (await cookies()).get(cfg.sessionCookieName)?.value;
  if (!sid) throw new Error("not signed in");
  const sess = await getSessionAccount(getDb(), sid);
  if (!sess) throw new Error("not signed in");
  // Throws PayoutForbiddenError for anyone not flygd+active — a cryo flygd
  // member reaches every action here and is rejected right here, not by a
  // guard the page merely hoped was upstream.
  await requirePayoutOperator(getDb(), sess.accountId);
  return sess.accountId;
}

function revalidateOperation(operationId: string): void {
  revalidatePath(`/payouts/${operationId}`);
  revalidatePath("/payouts");
}

export async function createOperationAction(formData: FormData): Promise<void> {
  const actor = await requireOperatorAccount();
  const name = field(formData, "name").trim();
  if (!name) throw new Error("name is required");
  const occurredAt = new Date(field(formData, "occurredAt"));
  if (Number.isNaN(occurredAt.getTime())) throw new Error("invalid date");
  const battleReportUrl = field(formData, "battleReportUrl").trim() || null;
  const corpSharePct = field(formData, "corpSharePct").trim() || "0";
  const notes = field(formData, "notes").trim() || null;

  const { id } = await getDb().transaction((dbtx) =>
    createOperation(dbtx, actor, {
      name,
      occurredAt,
      battleReportUrl,
      corpSharePct,
      notes,
    }),
  );
  revalidatePath("/payouts");
  redirect(`/payouts/${id}`);
}

export async function addAppraisedPoolAction(
  operationId: string,
  formData: FormData,
): Promise<void> {
  const actor = await requireOperatorAccount();
  const rawPaste = field(formData, "rawPaste");
  const pricingModeRaw = field(formData, "pricingMode");
  if (!PRICING_MODES.includes(pricingModeRaw as PricingMode)) {
    throw new Error("invalid pricing mode");
  }
  const pricingMode = pricingModeRaw as PricingMode;
  const stationRaw = field(formData, "stationId").trim();
  const regionRaw = field(formData, "regionId").trim();
  const stationId = stationRaw ? Number(stationRaw) : undefined;
  const regionId = regionRaw ? Number(regionRaw) : undefined;
  if ((stationId === undefined) === (regionId === undefined)) {
    // triff accepts exactly one of station_id/region_id; this mirrors
    // loot_pool_appraised_fields_ck so the operator sees the same rule the
    // database would otherwise enforce with a much less useful error.
    throw new Error("provide exactly one of station or region");
  }

  // ARCHITECTURAL EXCEPTION to "enqueue, don't execute" (see the design doc's
  // "An architectural exception, stated plainly"): appraisal is interactive —
  // the operator pastes loot and waits for a number, adjusts the pricing mode,
  // and pastes again — and this call is read-only and idempotent, so a lost or
  // duplicated call is a re-click, not a corrupted record. That is what makes
  // calling triff/ESI directly from the web tier safe here and nowhere else.
  const cfg = getConfig();
  const esi = createEsiClient({ userAgent: `authgd/0.1.0 (${cfg.esiContact})` });
  const triff = createTriffClient();

  try {
    const appraisal = await appraiseLoot(
      rawPaste,
      { pricingMode, stationId, regionId },
      { esi, triff },
    );
    await getDb().transaction((dbtx) =>
      addAppraisedPool(dbtx, actor, operationId, {
        rawPaste,
        pricingMode,
        stationId: stationId ?? null,
        regionId: regionId ?? null,
        appraisal,
      }),
    );
  } catch (err) {
    if (err instanceof TriffError) {
      // Visible error on the appraisal form, pool left unvalued — never a
      // silent partial total, per the design's Pricing/Failure handling.
      redirect(`/payouts/${operationId}?error=appraisal_failed`);
    }
    throw err;
  }
  revalidateOperation(operationId);
}

export async function addFlatPoolAction(
  operationId: string,
  formData: FormData,
): Promise<void> {
  const actor = await requireOperatorAccount();
  const totalValue = field(formData, "totalValue").trim();
  const notes = field(formData, "notes").trim();
  if (!notes) throw new Error("a flat pool requires a note explaining the number");
  const rawPaste = field(formData, "rawPaste").trim() || null;

  await getDb().transaction((dbtx) =>
    addFlatPool(dbtx, actor, operationId, { rawPaste, totalValue, notes }),
  );
  revalidateOperation(operationId);
}

export async function deletePoolAction(
  operationId: string,
  poolId: string,
): Promise<void> {
  const actor = await requireOperatorAccount();
  await getDb().transaction((dbtx) => deletePool(dbtx, actor, poolId));
  revalidateOperation(operationId);
}

export async function setRosterAction(
  operationId: string,
  formData: FormData,
): Promise<void> {
  const actor = await requireOperatorAccount();
  const raw = field(formData, "paste");
  const names = parseRosterPaste(raw);
  await getDb().transaction(async (dbtx) => {
    const entries = await resolveRosterNames(dbtx, names);
    await setRoster(dbtx, actor, operationId, entries);
  });
  revalidateOperation(operationId);
}

export async function setParticipantSharesAction(
  operationId: string,
  participantId: string,
  formData: FormData,
): Promise<void> {
  const actor = await requireOperatorAccount();
  const shares = field(formData, "shares").trim();
  if (!shares) throw new Error("shares is required");
  await getDb().transaction((dbtx) =>
    setParticipantShares(dbtx, actor, participantId, shares),
  );
  revalidateOperation(operationId);
}

export async function setParticipantExcludedAction(
  operationId: string,
  participantId: string,
  excluded: boolean,
): Promise<void> {
  const actor = await requireOperatorAccount();
  await getDb().transaction((dbtx) =>
    setParticipantExcluded(dbtx, actor, participantId, excluded),
  );
  revalidateOperation(operationId);
}

export async function removeParticipantAction(
  operationId: string,
  participantId: string,
): Promise<void> {
  const actor = await requireOperatorAccount();
  await getDb().transaction((dbtx) => removeParticipant(dbtx, actor, participantId));
  revalidateOperation(operationId);
}

export async function finalizeAction(operationId: string): Promise<void> {
  const actor = await requireOperatorAccount();
  await getDb().transaction((dbtx) => finalizeOperation(dbtx, actor, operationId));
  revalidateOperation(operationId);
}

export async function unlockAction(operationId: string): Promise<void> {
  const actor = await requireOperatorAccount();
  await getDb().transaction((dbtx) => unlockOperation(dbtx, actor, operationId));
  revalidateOperation(operationId);
}

export async function markPaidAction(
  operationId: string,
  participantId: string,
): Promise<void> {
  const actor = await requireOperatorAccount();
  await getDb().transaction((dbtx) => recordPayment(dbtx, actor, participantId));
  revalidateOperation(operationId);
}
