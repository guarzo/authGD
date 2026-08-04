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
import { createEsiClient, EsiError } from "@/lib/esi/client";
import { createTriffClient, TriffError } from "@/lib/triff/client";
import { PRICING_MODES, type PricingMode } from "@/core/pricing";
import { parseRosterPaste } from "@/core/roster-paste";
import { iskToCents } from "@/core/payout-split";

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
  const battleReportUrlRaw = field(formData, "battleReportUrl").trim() || null;
  // Rendered as a plain `<a href>` on the detail page — reject anything but
  // http(s) here so a `javascript:` or other scheme can never reach that link.
  if (battleReportUrlRaw) {
    let scheme: string;
    try {
      scheme = new URL(battleReportUrlRaw).protocol;
    } catch {
      throw new Error("battle report URL is not a valid URL");
    }
    if (scheme !== "http:" && scheme !== "https:") {
      throw new Error("battle report URL must be http or https");
    }
  }
  const battleReportUrl = battleReportUrlRaw;
  const corpSharePct = field(formData, "corpSharePct").trim() || "0";
  // The <input type="number" min max> on the form is client-side only —
  // mirrors payout_operation_corp_share_pct_ck with a readable message before
  // the raw string reaches the numeric(5,2) column, same precedent addFlatPool
  // sets for its totalValue field.
  if (!/^\d+(\.\d{1,2})?$/.test(corpSharePct)) {
    throw new Error("corp share must be a plain number like 10 or 10.5");
  }
  if (Number(corpSharePct) > 100) {
    throw new Error("corp share cannot exceed 100%");
  }
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
  // A non-numeric id must reject here, not travel to triff as a query param
  // or reach the lootPool insert's bigint column as NaN.
  if (stationRaw && !/^\d+$/.test(stationRaw)) throw new Error("invalid station id");
  if (regionRaw && !/^\d+$/.test(regionRaw)) throw new Error("invalid region id");
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
    if (err instanceof TriffError || err instanceof EsiError) {
      // Visible error on the appraisal form, pool left unvalued — never a
      // silent partial total, per the design's Pricing/Failure handling. An
      // ESI failure (name resolution inside appraiseLoot's resolveIds) is just
      // as much a transient upstream failure as a triff failure and deserves
      // the same friendly path, not an uncaught exit past this catch.
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
  // <input type="number"> accepts scientific notation like "1e5" client-side;
  // iskToCents' regex rejects it, but let this action fail with the same
  // readable message the other numeric fields above use, rather than relying
  // solely on addFlatPool's deeper (also correct) check.
  if (!/^-?\d+(\.\d{1,2})?$/.test(totalValue)) {
    throw new Error("total must be a plain number like 12345.67");
  }

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
  // Mirrors payout_participant_shares_ck (shares > 0) with a readable message
  // before the raw string reaches the numeric(6,2) column — "abc" or "1e5"
  // would otherwise die as a raw Postgres invalid-input-syntax error.
  if (iskToCents(shares) <= 0n) {
    throw new Error("shares must be a positive number");
  }
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
