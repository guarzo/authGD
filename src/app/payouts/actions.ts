"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { appraiseLoot } from "@/services/appraisal";
import {
  addAppraisedPool,
  addFlatPool,
  deletePool,
  setItemPrice,
} from "@/services/payout-loot";
import {
  MAX_SHARES_HUNDREDTHS,
  PayoutDuplicateParticipantError,
  PayoutHasPaidError,
  addParticipant,
  createOperation,
  deleteOperation,
  finalizeOperation,
  getOpenInfoTarget,
  recordPayment,
  removeParticipant,
  requirePayoutOperator,
  resolveRosterNames,
  revertPayment,
  setBattleReportUrl,
  setCorpSharePct,
  setNotes,
  setOccurredAt,
  setOperationName,
  setParticipantExcluded,
  setParticipantShares,
  setRoster,
  unlockOperation,
} from "@/services/payouts";
import { getSessionAccount } from "@/services/session";
import { getFreshAccessToken, getMainCharacterWithScope } from "@/services/tokens";
import { createEsiClient, EsiError, OPEN_WINDOW_SCOPE } from "@/lib/esi/client";
import { classifyOpenInfoFailure } from "@/core/open-info-error";
import { createTriffClient, TriffError } from "@/lib/triff/client";
import type { PricingMode } from "@/core/pricing";
import { parseRosterPaste } from "@/core/roster-paste";
import { iskToCents } from "@/core/payout-split";
import { encodeDropped } from "./dropped";
import type { NewOperationErrorCode, OperationErrorCode } from "./errors";

/**
 * `addAppraisedPoolAction` used to read these from the form: a "Pricing"
 * `<select>` of four modes, a "Price at" `<select>` of station/region, and a
 * free-numeric station/region id defaulted to 60003760 (Jita 4-4). This
 * deployment has exactly one pricing policy and always will, so those were
 * three user-facing controls that only ever took their own default — removed
 * from `AppraiseForm` entirely, and hardcoded here instead. `pricing_mode`
 * column and `loot_pool_appraised_fields_ck` (exactly one of station/region
 * id) still require these fields on every pool row; a fixed pair satisfies
 * both identically to what the removed controls always submitted.
 */
const APPRAISAL_PRICING_MODE: PricingMode = "sell_best";
const APPRAISAL_STATION_ID = 60003760;

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
  // Throws PayoutForbiddenError for anyone not member+active — a cryo member
  // reaches every action here and is rejected right here, not by a
  // guard the page merely hoped was upstream.
  await requirePayoutOperator(getDb(), sess.accountId);
  return sess.accountId;
}

function revalidateOperation(operationId: string): void {
  revalidatePath(`/payouts/${operationId}`);
  revalidatePath("/payouts");
}

/** Every input rejection below is an operator typo, not a fault on our end.
 *  Throwing would land on error.tsx, which renders `error.digest` and never
 *  `error.message` — so the operator gets "Something broke… that's a fault on
 *  this end, not something you did" with no idea which field, and loses the
 *  form. `requireAdminAction` went through exactly this conversion already
 *  (see e2e/admin.spec.ts's docblock); these are the sites that never did.
 *
 *  Both helpers return `never` because `redirect` throws NEXT_REDIRECT, which
 *  is also why no call to either may sit inside a `try` — an enclosing catch
 *  swallows the redirect and the operator lands back on error.tsx anyway.
 *
 *  `code` is the destination page's own union, not `string`. A code the page's
 *  map has no entry for renders nothing at all — an unchanged form and no
 *  explanation, the one failure these pages cannot show an operator — so it
 *  fails typecheck here instead of deploying. The two unions are separate on
 *  purpose: `share_format` and `share_range` exist in both maps with copy
 *  worded for their own page (see `./errors`). */
function operationFailed(operationId: string, code: OperationErrorCode): never {
  redirect(`/payouts/${operationId}?error=${code}`);
}

/** The create form has nowhere to fall back to — a rejected operation does not
 *  exist yet, so /payouts/new is both the origin and the destination. Echo the
 *  submitted values back so the operator corrects one field instead of retyping
 *  the other.
 *
 *  Just the two fields the slimmed-down form still asks for. Battle report,
 *  corp share, and notes all moved to the detail page's own editors (see
 *  `setBattleReportUrlAction`, `setCorpShareAction`, `setNotesAction` below) —
 *  `createOperation` reads corp share from `getConfig().payoutCorpSharePct`
 *  (a deployment-wide default, not a per-operation one) and leaves the other
 *  two null when the create form does not send them. */
const CREATE_FIELDS = ["name", "occurredAt"] as const;

function createFailed(formData: FormData, code: NewOperationErrorCode): never {
  const params = new URLSearchParams({ error: code });
  for (const key of CREATE_FIELDS) {
    const value = field(formData, key);
    if (value && value.length <= 500) params.set(key, value);
  }
  redirect(`/payouts/new?${params.toString()}`);
}

export async function createOperationAction(formData: FormData): Promise<void> {
  const actor = await requireOperatorAccount();
  const name = field(formData, "name").trim();
  if (!name) createFailed(formData, "name_required");
  const occurredAt = new Date(field(formData, "occurredAt"));
  if (Number.isNaN(occurredAt.getTime())) createFailed(formData, "date_invalid");

  // Battle report, corp share, and notes are no longer collected here — they
  // moved to the detail page's own editors once the operation exists (see
  // `setBattleReportUrlAction`, `setCorpShareAction`, `setNotesAction` below).
  // Corp share comes from config rather than a literal: it is set once per
  // deployment, not once per operation, and `createOperation`'s own
  // `input.corpSharePct ?? "10"` fallback exists only for callers (tests)
  // that omit the field entirely.
  const { id } = await getDb().transaction((dbtx) =>
    createOperation(dbtx, actor, {
      name,
      occurredAt,
      corpSharePct: getConfig().payoutCorpSharePct,
    }),
  );
  revalidatePath("/payouts");
  redirect(`/payouts/${id}`);
}

/** The one rejection on this page that `useActionState` handles instead of a
 *  `?error=` redirect — see `AppraiseForm`'s docblock for why. `null` is the
 *  hook's initial state: `state === null` never renders a notice, whether
 *  that means "hasn't submitted yet" or "still pending", and `ok: true` on a
 *  success lets a client leaf tell that apart from either of those without
 *  reading anything from the query string.
 *
 *  `ok: true` also carries `dropped`: the same base64url payload
 *  `encodeDropped` used to hand straight to a `redirect()` target, non-null
 *  only when the paste dropped at least one line. This action used to redirect
 *  there itself on that path, which is exactly the defect this sweep already
 *  fixed twice elsewhere (`admin/accounts/actions.ts`,
 *  `admin/sync/actions.ts`): a server `redirect()` back to the SAME page is
 *  still a route transition, and every `Disclosure` on this page holds its
 *  open/closed state in a plain `useState` with nowhere else to live, so the
 *  transition silently closed whatever pool or roster panel the operator had
 *  open elsewhere the moment a paste happened to drop one line. Returning the
 *  payload as state instead keeps `AppraiseForm` mounted; it pushes the param
 *  into the URL itself via `router.replace` once this resolves — see that
 *  component's own docblock for the mechanics, and `clear-stale-query.tsx`'s
 *  for why `replace` and not `redirect` is the safe one. */
export type AppraiseActionState =
  { ok: true; dropped: string | null } | { ok: false; code: "appraisal_failed" } | null;

export async function addAppraisedPoolAction(
  operationId: string,
  _prevState: AppraiseActionState,
  formData: FormData,
): Promise<AppraiseActionState> {
  const actor = await requireOperatorAccount();
  const rawPaste = field(formData, "rawPaste");
  const pricingMode = APPRAISAL_PRICING_MODE;
  const stationId = APPRAISAL_STATION_ID;
  const regionId = undefined;

  // ARCHITECTURAL EXCEPTION to "enqueue, don't execute": appraisal is
  // interactive — the operator pastes loot, waits for a number, and pastes
  // again if it looks wrong — and this call is read-only and idempotent,
  // so a lost or duplicated call is a re-click, not a corrupted record. That is
  // what makes calling triff/ESI directly from the web tier safe here and
  // nowhere else.
  const cfg = getConfig();
  const esi = createEsiClient({ userAgent: `authgd/0.1.0 (${cfg.esiContact})` });
  const triff = createTriffClient();

  // Declared outside the try only for scope — nothing below throws a
  // control-flow signal on this path anymore. It used to be carried out so a
  // `redirect()` after the try/catch would not be caught and rethrown by the
  // `catch` below; that redirect is gone (see `AppraiseActionState`'s own
  // comment for why), and the value now travels home as returned state
  // instead.
  let droppedParam: string | null = null;
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
    // Dropped lines are never persisted (design, defect 3), so the only way the
    // next render learns about them is the query string — same mechanism the
    // failure path above uses, carrying a payload instead of a fixed code.
    if (appraisal.dropped.length > 0) {
      droppedParam = encodeDropped(appraisal.dropped);
    }
  } catch (err) {
    if (err instanceof TriffError || err instanceof EsiError) {
      // Returned, not redirected: a redirect can only carry a fixed code in
      // the query string, and that is exactly the channel that cannot hold a
      // paste running hundreds of lines back to the form. Returning it as
      // `useActionState` state instead keeps `AppraiseForm` mounted — nothing
      // navigates, so the paste the operator just typed is still sitting in
      // the textarea when this renders, not merely echoed back from a URL.
      return { ok: false, code: "appraisal_failed" };
    }
    throw err;
  }
  revalidateOperation(operationId);
  return { ok: true, dropped: droppedParam };
}

/**
 * The state shape shared by every inline single-value editor on this page
 * whose rejection has to leave the operator's own typed value on screen
 * rather than whatever is still in the database.
 *
 * This is the fix for the design sweep's "a rejected edit discards what was
 * typed" defect: `operationFailed`'s `?error=` redirect can only carry a fixed
 * code, never the value that produced it, so the redirect re-rendered the
 * page from server state and the typed value was simply gone — on a money
 * screen, at the exact moment the operator most needed to see what they'd
 * entered to fix it. `useActionState` returns state instead of navigating,
 * the same trick `addAppraisedPoolAction` / `AppraiseForm` already established
 * for the loot paste (see that action's own comment); this is that trick's
 * single-field, per-row twin, reused by every action below whose form has
 * exactly one text/number input to preserve.
 *
 * `value` is only ever the REJECTED input — an `ok: true` state carries none,
 * on purpose. The client component that renders this (`InlineEditField`)
 * falls back to the current server value once `ok` is true, so a successful
 * save is never left showing a value that merely resembles what was
 * committed; it shows what the reload actually says.
 */
export type StringFieldEditState =
  { ok: true } | { ok: false; code: OperationErrorCode; value: string } | null;

/**
 * `addFlatPoolAction`'s own three-field twin of `StringFieldEditState` — a
 * flat pool has no single field to echo back, and totalValue/notes/rawPaste
 * all have to survive a rejection together or an operator who mistypes the
 * total loses the note explaining where the number came from too.
 */
export type FlatPoolEditState =
  | { ok: true }
  | {
      ok: false;
      code: OperationErrorCode;
      totalValue: string;
      notes: string;
      rawPaste: string;
    }
  | null;

export async function addFlatPoolAction(
  operationId: string,
  _prevState: FlatPoolEditState,
  formData: FormData,
): Promise<FlatPoolEditState> {
  const actor = await requireOperatorAccount();
  const totalValue = field(formData, "totalValue").trim();
  const notes = field(formData, "notes").trim();
  const rawPaste = field(formData, "rawPaste").trim();
  if (!notes) {
    return { ok: false, code: "note_required", totalValue, notes, rawPaste };
  }
  // <input type="number"> accepts scientific notation like "1e5" client-side;
  // iskToCents' regex rejects it, but let this action fail with the same
  // readable message the other numeric fields above use, rather than relying
  // solely on addFlatPool's deeper (also correct) check.
  if (!/^-?\d+(\.\d{1,2})?$/.test(totalValue)) {
    return { ok: false, code: "total_invalid", totalValue, notes, rawPaste };
  }

  await getDb().transaction((dbtx) =>
    addFlatPool(dbtx, actor, operationId, {
      rawPaste: rawPaste || null,
      totalValue,
      notes,
    }),
  );
  revalidateOperation(operationId);
  return { ok: true };
}

export async function deletePoolAction(
  operationId: string,
  poolId: string,
): Promise<void> {
  const actor = await requireOperatorAccount();
  await getDb().transaction((dbtx) => deletePool(dbtx, actor, poolId));
  revalidateOperation(operationId);
}

export async function setItemPriceAction(
  operationId: string,
  itemId: string,
  _prevState: StringFieldEditState,
  formData: FormData,
): Promise<StringFieldEditState> {
  const actor = await requireOperatorAccount();
  const unitPrice = field(formData, "unitPrice").trim();
  // Two decimals is what numeric(20,2) holds. A third is refused rather than
  // rounded: an operator who typed 0.004 meant something specific, and a
  // silent round to 0.01 would inflate the line 2.5x with no sign of it. The
  // escape hatch for genuinely sub-cent heaps is the flat-total pool, which
  // takes a pool value directly and skips per-item pricing.
  if (!/^\d+(\.\d{1,2})?$/.test(unitPrice)) {
    return { ok: false, code: "price_invalid", value: unitPrice };
  }
  await getDb().transaction((dbtx) => setItemPrice(dbtx, actor, itemId, unitPrice));
  revalidateOperation(operationId);
  return { ok: true };
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

/** Both rejections here are things the operator typed, so both return state
 *  rather than throwing — the conversion #74 applied to every other input
 *  rejection in this file. A throw would land on error.tsx, which renders
 *  `error.digest` and never `error.message`, telling them a blank name box
 *  was a fault on our end. `operationFailed`'s `?error=` redirect used to be
 *  the mechanism; it discarded the typed name on rejection (this sweep's
 *  defect 3), so this now follows `setItemPriceAction`'s `StringFieldEditState`
 *  pattern instead — the try/catch shape below is otherwise unchanged. */
export async function addParticipantAction(
  operationId: string,
  _prevState: StringFieldEditState,
  formData: FormData,
): Promise<StringFieldEditState> {
  const actor = await requireOperatorAccount();
  const name = field(formData, "name").trim();
  if (!name) return { ok: false, code: "participant_name_required", value: name };
  try {
    await getDb().transaction((dbtx) => addParticipant(dbtx, actor, operationId, name));
  } catch (err) {
    if (err instanceof PayoutDuplicateParticipantError) {
      return { ok: false, code: "participant_duplicate", value: name };
    }
    throw err;
  }
  revalidateOperation(operationId);
  return { ok: true };
}

export async function setParticipantSharesAction(
  operationId: string,
  participantId: string,
  _prevState: StringFieldEditState,
  formData: FormData,
): Promise<StringFieldEditState> {
  const actor = await requireOperatorAccount();
  const shares = field(formData, "shares").trim();
  if (!shares) return { ok: false, code: "shares_required", value: shares };
  // Format first, positivity second, and in that order deliberately: iskToCents
  // *throws* on anything its regex rejects (core/payout-split.ts), so calling it
  // on "abc" would escape past the checks below — and text in a numeric field
  // is the likeliest bad input this control gets. Mirrors the regex-then-parse
  // order addFlatPoolAction already uses for totalValue.
  if (!/^-?\d+(\.\d{1,2})?$/.test(shares)) {
    return { ok: false, code: "shares_invalid", value: shares };
  }
  // Mirrors payout_participant_shares_ck (shares > 0) with a readable message
  // before the raw string reaches the numeric(6,2) column.
  if (iskToCents(shares) <= 0n) {
    return { ok: false, code: "shares_positive", value: shares };
  }
  // The numeric(6, 2) column's own range, mirrored here for the same reason the
  // three checks above mirror the format and payout_participant_shares_ck: an
  // unbounded "10000" reaches Postgres as a raw numeric overflow. assertSharesInRange
  // in the service enforces this for every caller; this copy is the one that can
  // give the operator a page with their roster still on it. Same constant, so the
  // two cannot drift.
  if (iskToCents(shares) > MAX_SHARES_HUNDREDTHS) {
    return { ok: false, code: "shares_range", value: shares };
  }
  await getDb().transaction((dbtx) =>
    setParticipantShares(dbtx, actor, participantId, shares),
  );
  revalidateOperation(operationId);
  return { ok: true };
}

/** Four inline editors for fields the create form no longer collects up
 *  front (name/date) plus the two that were always freeform (report link,
 *  notes) — one action per field, mirroring `setOperationName` /
 *  `setOccurredAt` / `setBattleReportUrl` / `setNotes`'s own one-function-
 *  per-field split in the service layer. Each redirects on its own input
 *  rejection through `operationFailed`, the same conversion every other input
 *  rejection on this page already goes through, and every service call is
 *  gated by `assertEditable` underneath — reachable only while `canEdit` is
 *  true on the page. `setCorpShareAction` below is NOT one of the four its
 *  own action-per-field editor moved with it — see that action's own
 *  comment. */
export async function setNameAction(
  operationId: string,
  _prevState: StringFieldEditState,
  formData: FormData,
): Promise<StringFieldEditState> {
  const actor = await requireOperatorAccount();
  const name = field(formData, "name").trim();
  if (!name) return { ok: false, code: "name_required", value: name };
  await getDb().transaction((dbtx) => setOperationName(dbtx, actor, operationId, name));
  revalidateOperation(operationId);
  return { ok: true };
}

export async function setOccurredAtAction(
  operationId: string,
  _prevState: StringFieldEditState,
  formData: FormData,
): Promise<StringFieldEditState> {
  const actor = await requireOperatorAccount();
  const raw = field(formData, "occurredAt");
  const occurredAt = new Date(raw);
  if (Number.isNaN(occurredAt.getTime())) {
    return { ok: false, code: "date_invalid", value: raw };
  }
  await getDb().transaction((dbtx) =>
    setOccurredAt(dbtx, actor, operationId, occurredAt),
  );
  revalidateOperation(operationId);
  return { ok: true };
}

export async function setBattleReportUrlAction(
  operationId: string,
  _prevState: StringFieldEditState,
  formData: FormData,
): Promise<StringFieldEditState> {
  const actor = await requireOperatorAccount();
  const raw = field(formData, "battleReportUrl").trim();
  // Same http(s)-only check `createOperationAction` runs, and for the same
  // reason: this is rendered as a plain `<a href>` on this very page, so a
  // `javascript:` or other scheme must never reach the database.
  if (raw) {
    let scheme: string;
    try {
      scheme = new URL(raw).protocol;
    } catch {
      return { ok: false, code: "url_invalid", value: raw };
    }
    if (scheme !== "http:" && scheme !== "https:") {
      return { ok: false, code: "url_scheme", value: raw };
    }
  }
  await getDb().transaction((dbtx) =>
    setBattleReportUrl(dbtx, actor, operationId, raw || null),
  );
  revalidateOperation(operationId);
  return { ok: true };
}

export async function setNotesAction(
  operationId: string,
  formData: FormData,
): Promise<void> {
  const actor = await requireOperatorAccount();
  const notes = field(formData, "notes").trim() || null;
  await getDb().transaction((dbtx) => setNotes(dbtx, actor, operationId, notes));
  revalidateOperation(operationId);
}

/** No longer called from the page: corp share editing was an inline `<form>`
 *  in the facts grid, removed because the share is set once per deployment
 *  (a config default), not once per operation — an operator adjusting it here
 *  was correcting a number that shouldn't have varied operation to operation
 *  in the first place. The action, `setCorpSharePct` underneath it, and the
 *  `corpSharePct` column all stay: `tests/payouts-service.test.ts` still
 *  exercises `setCorpSharePct` directly, and a future admin-facing override
 *  (if one is ever added) would call through this same action rather than a
 *  new one. `share_format` / `share_range` in `errors.ts` are consequently
 *  unreachable by this page's own UI now, same as the appraisal backstops —
 *  see that file's docblock. */
export async function setCorpShareAction(
  operationId: string,
  formData: FormData,
): Promise<void> {
  const actor = await requireOperatorAccount();
  const corpSharePct = field(formData, "corpSharePct").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(corpSharePct)) {
    operationFailed(operationId, "share_format");
  }
  if (Number(corpSharePct) > 100) {
    operationFailed(operationId, "share_range");
  }
  await getDb().transaction((dbtx) =>
    setCorpSharePct(dbtx, actor, operationId, corpSharePct),
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

/**
 * Admin-only, and gated regardless of status — a finalized operation whose
 * every payment has been reverted is exactly as deletable as a draft nobody
 * ever priced, because `deleteOperation` keys the refusal on a currently-paid
 * participant, not on the lifecycle stage. `requireOperatorAccount` above
 * proves member+active; `deleteOperation` re-checks `isAdmin` itself, the same
 * "every mutation re-checks itself" rule `access.ts` states, so a forged
 * request from a non-admin operator still lands on error.tsx rather than
 * silently deleting.
 *
 * `PayoutHasPaidError` is the one rejection worth a redirect: it can only be
 * reached by clicking a control the page renders regardless of paid state
 * (the count of currently-paid participants is not known until the delete
 * itself checks it, since a payment can be reverted after the page loads by
 * another tab), so it needs its own explanation rather than error.tsx's
 * "fault on our end". The redirect target is this operation's own page — the
 * one place left to redirect to once the delete itself has failed — never
 * `/payouts`, which is reserved for a delete that actually happened.
 */
export async function deleteOperationAction(operationId: string): Promise<void> {
  const actor = await requireOperatorAccount();
  try {
    await getDb().transaction((dbtx) => deleteOperation(dbtx, actor, operationId));
  } catch (err) {
    if (err instanceof PayoutHasPaidError) {
      operationFailed(operationId, "delete_has_paid");
    }
    throw err;
  }
  revalidatePath("/payouts");
  redirect("/payouts");
}

export async function markPaidAction(
  operationId: string,
  participantId: string,
): Promise<void> {
  const actor = await requireOperatorAccount();
  await getDb().transaction((dbtx) => recordPayment(dbtx, actor, participantId));
  revalidateOperation(operationId);
}

/** getFreshAccessToken's four failure reasons, mapped to the `?error=` codes
 *  the detail page renders. Every branch has a message: an operator who clicks
 *  a control and sees nothing happen cannot tell a dead token from a client
 *  they forgot to log into. */
const OPEN_INFO_ERROR_BY_REASON = {
  no_token: "open_info_reauth",
  invalid: "open_info_reauth",
  transient: "open_info_failed",
  dry_run: "open_info_dry_run",
} as const;

/** classifyOpenInfoFailure's verdicts, mapped to the same `?error=` codes.
 *  Kept next to the map above so the `open_info_*` keys of OPERATION_ERRORS
 *  have exactly two producers and both are visible at once. Neither map is
 *  annotated: both feed `operationFailed`, so an entry naming a code that
 *  OPERATION_ERRORS has no message for fails typecheck at the call site. */
const OPEN_INFO_ERROR_BY_FAILURE = {
  reauth: "open_info_reauth",
  offline: "open_info_offline",
  busy: "open_info_busy",
  timeout: "open_info_timeout",
  failed: "open_info_failed",
} as const;

/**
 * Opens the in-game information window for a participant's stored recipient
 * character on the operator's own client, so they can right-click through to a
 * transfer without retyping a name.
 *
 * ARCHITECTURAL EXCEPTION to "enqueue, don't execute" — the second one, after
 * interactive appraisal above. The original justification was "read-only and
 * idempotent", and this is a POST, so it needs its own: the call persists NO
 * state, at CCP or here. Its entire effect is a window appearing on a game
 * client. A duplicated call opens it twice, a lost call opens nothing and the
 * operator clicks again, and there is no record to corrupt. Queueing it would
 * be actively worse — the window would surface minutes later on a client that
 * has moved on.
 *
 * Takes a participant id, never a character id: the target is re-read from the
 * database inside the action (see getOpenInfoTarget). Nothing changed, so
 * nothing is revalidated.
 *
 * Every failure below goes out through `operationFailed`, the module's own
 * `: never`-typed redirect helper, for the reasons argued at the top of this
 * task: these are upstream and grant failures on a control that persists
 * nothing, and error.tsx can only call them a fault on our end. What does NOT
 * redirect is requireOperatorAccount's throw above and an unclassifiable error
 * below — a forged request and a bug, both of which want a stack trace.
 */
export async function openInfoAction(
  operationId: string,
  participantId: string,
): Promise<void> {
  const actor = await requireOperatorAccount();
  const cfg = getConfig();
  const db = getDb();

  // Gated on what this operator GRANTED, not on what config asks for. The
  // control should already be hidden for them; reaching here means a stale
  // page or a hand-made request, and it gets a message, not a 500.
  const main = await getMainCharacterWithScope(db, actor, OPEN_WINDOW_SCOPE);
  if (!main) operationFailed(operationId, "open_info_reauth");

  // The authorization that matters. requireOperatorAccount above proves this
  // caller may operate payouts; it proves nothing about WHOSE window opens.
  // The id that reaches ESI comes from this row, not from the arguments.
  const targetId = await getOpenInfoTarget(db, operationId, participantId);
  if (targetId === null) operationFailed(operationId, "open_info_target");

  const token = await getFreshAccessToken(db, cfg, main);
  if (!token.ok) operationFailed(operationId, OPEN_INFO_ERROR_BY_REASON[token.reason]);

  const esi = createEsiClient({
    userAgent: `authgd/0.1.0 (${cfg.esiContact})`,
    // Unlike appraisal (a read), this is a write and must honour dry-run. In
    // practice getFreshAccessToken already refuses above in dry-run mode; this
    // is the boundary guard sync-mode.ts asks every write to pass through.
    syncMode: cfg.syncMode,
  });
  try {
    await esi.openInformationWindow(main.id, token.accessToken, targetId);
  } catch (err) {
    const failure = classifyOpenInfoFailure(err);
    // null means we cannot describe it honestly — a bug, a DNS failure, a
    // malformed response. Those get a stack trace, not a reassuring sentence.
    if (failure === null) throw err;
    operationFailed(operationId, OPEN_INFO_ERROR_BY_FAILURE[failure]);
  }
}

/**
 * Takes back a payment an operator recorded wrongly. `revertPayment` clears
 * `paidAmount` and appends a `reverted` event, so the participant can be paid
 * again; the operation stays frozen either way, because money did move.
 *
 * Nothing is caught. Every failure `revertPayment` can raise is authorization
 * (PayoutForbiddenError) or lifecycle state (PayoutLockedError,
 * PayoutNotFoundError) — none of them is something the operator typed, and none
 * of them has a field to hand back. That is exactly the line the ?error=
 * conversion drew across this file: input rejections redirect, and everything
 * else belongs on error.tsx. This action has no input to reject.
 */
export async function revertPaymentAction(
  operationId: string,
  participantId: string,
): Promise<void> {
  const actor = await requireOperatorAccount();
  await getDb().transaction((dbtx) => revertPayment(dbtx, actor, participantId));
  revalidateOperation(operationId);
}
