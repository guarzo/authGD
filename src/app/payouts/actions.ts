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
import { PRICING_MODES, type PricingMode } from "@/core/pricing";
import { parseRosterPaste } from "@/core/roster-paste";
import { iskToCents } from "@/core/payout-split";
import { encodeDropped } from "./dropped";
import type { NewOperationErrorCode, OperationErrorCode } from "./errors";

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
 *  `createOperation` defaults corp share to 10% and leaves the other two null
 *  when the create form does not send them. */
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
  // `createOperation` defaults corp share to 10% and leaves the other two null.
  const { id } = await getDb().transaction((dbtx) =>
    createOperation(dbtx, actor, { name, occurredAt }),
  );
  revalidatePath("/payouts");
  redirect(`/payouts/${id}`);
}

/** The one rejection on this page that `useActionState` handles instead of a
 *  `?error=` redirect — see `AppraiseForm`'s docblock for why. `null` is the
 *  hook's initial state: `state === null` never renders a notice, whether
 *  that means "hasn't submitted yet" or "still pending", and `ok: true` on a
 *  success lets a client leaf tell that apart from either of those without
 *  reading anything from the query string. */
export type AppraiseActionState =
  { ok: true } | { ok: false; code: "appraisal_failed" } | null;

export async function addAppraisedPoolAction(
  operationId: string,
  _prevState: AppraiseActionState,
  formData: FormData,
): Promise<AppraiseActionState> {
  const actor = await requireOperatorAccount();
  const rawPaste = field(formData, "rawPaste");
  const pricingModeRaw = field(formData, "pricingMode");
  if (!PRICING_MODES.includes(pricingModeRaw as PricingMode)) {
    operationFailed(operationId, "pricing_mode");
  }
  const pricingMode = pricingModeRaw as PricingMode;
  // The form posts a location *kind* plus a single id, so "exactly one of
  // station or region" — loot_pool_appraised_fields_ck, and triff's own rule —
  // is structurally true rather than checked after the fact. That matters more
  // here than anywhere else on the page: a redirect cannot carry the loot paste
  // back, so the only acceptable place to catch a mis-filled location is before
  // the form submits at all.
  const locationKind = field(formData, "locationKind");
  const locationRaw = field(formData, "locationId").trim();
  if (locationKind !== "station" && locationKind !== "region") {
    operationFailed(operationId, "location_kind");
  }
  // A non-numeric id must reject here, not travel to triff as a query param
  // or reach the lootPool insert's bigint column as NaN.
  if (!/^\d+$/.test(locationRaw)) {
    operationFailed(
      operationId,
      locationKind === "station" ? "station_invalid" : "region_invalid",
    );
  }
  const locationId = Number(locationRaw);
  const stationId = locationKind === "station" ? locationId : undefined;
  const regionId = locationKind === "region" ? locationId : undefined;

  // ARCHITECTURAL EXCEPTION to "enqueue, don't execute" (see the design doc's
  // "An architectural exception, stated plainly"): appraisal is interactive —
  // the operator pastes loot and waits for a number, adjusts the pricing mode,
  // and pastes again — and this call is read-only and idempotent, so a lost or
  // duplicated call is a re-click, not a corrupted record. That is what makes
  // calling triff/ESI directly from the web tier safe here and nowhere else.
  const cfg = getConfig();
  const esi = createEsiClient({ userAgent: `authgd/0.1.0 (${cfg.esiContact})` });
  const triff = createTriffClient();

  // Carried out of the try so the redirect below runs after it: `redirect()`
  // throws a control-flow signal, and calling it inside the try would be
  // caught by the `catch` and rethrown as an unhandled error.
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
  if (droppedParam) redirect(`/payouts/${operationId}?dropped=${droppedParam}`);
  return { ok: true };
}

export async function addFlatPoolAction(
  operationId: string,
  formData: FormData,
): Promise<void> {
  const actor = await requireOperatorAccount();
  const totalValue = field(formData, "totalValue").trim();
  const notes = field(formData, "notes").trim();
  if (!notes) operationFailed(operationId, "note_required");
  const rawPaste = field(formData, "rawPaste").trim() || null;
  // <input type="number"> accepts scientific notation like "1e5" client-side;
  // iskToCents' regex rejects it, but let this action fail with the same
  // readable message the other numeric fields above use, rather than relying
  // solely on addFlatPool's deeper (also correct) check.
  if (!/^-?\d+(\.\d{1,2})?$/.test(totalValue)) {
    operationFailed(operationId, "total_invalid");
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

export async function setItemPriceAction(
  operationId: string,
  itemId: string,
  formData: FormData,
): Promise<void> {
  const actor = await requireOperatorAccount();
  const unitPrice = field(formData, "unitPrice").trim();
  // Two decimals is what numeric(20,2) holds. A third is refused rather than
  // rounded: an operator who typed 0.004 meant something specific, and a
  // silent round to 0.01 would inflate the line 2.5x with no sign of it. The
  // escape hatch for genuinely sub-cent heaps is the flat-total pool, which
  // takes a pool value directly and skips per-item pricing.
  if (!/^\d+(\.\d{1,2})?$/.test(unitPrice)) {
    operationFailed(operationId, "price_invalid");
  }
  await getDb().transaction((dbtx) => setItemPrice(dbtx, actor, itemId, unitPrice));
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

/** Both rejections here are things the operator typed, so both redirect rather
 *  than throw — the conversion #74 applied to every other input rejection in
 *  this file. A throw would land on error.tsx, which renders `error.digest` and
 *  never `error.message`, telling them a blank name box was a fault on our end.
 *
 *  `operationFailed` returns `never` and must not be called from inside a `try`
 *  — `redirect` signals by throwing NEXT_REDIRECT, and an enclosing catch would
 *  swallow it. The call below sits in the `catch`, not the `try`. */
export async function addParticipantAction(
  operationId: string,
  formData: FormData,
): Promise<void> {
  const actor = await requireOperatorAccount();
  const name = field(formData, "name").trim();
  if (!name) operationFailed(operationId, "participant_name_required");
  try {
    await getDb().transaction((dbtx) => addParticipant(dbtx, actor, operationId, name));
  } catch (err) {
    if (err instanceof PayoutDuplicateParticipantError) {
      operationFailed(operationId, "participant_duplicate");
    }
    throw err;
  }
  revalidateOperation(operationId);
}

export async function setParticipantSharesAction(
  operationId: string,
  participantId: string,
  formData: FormData,
): Promise<void> {
  const actor = await requireOperatorAccount();
  const shares = field(formData, "shares").trim();
  if (!shares) operationFailed(operationId, "shares_required");
  // Format first, positivity second, and in that order deliberately: iskToCents
  // *throws* on anything its regex rejects (core/payout-split.ts), so calling it
  // on "abc" would escape to error.tsx past the redirect below — and text in a
  // numeric field is the likeliest bad input this control gets. Mirrors the
  // regex-then-parse order addFlatPoolAction already uses for totalValue.
  if (!/^-?\d+(\.\d{1,2})?$/.test(shares)) {
    operationFailed(operationId, "shares_invalid");
  }
  // Mirrors payout_participant_shares_ck (shares > 0) with a readable message
  // before the raw string reaches the numeric(6,2) column.
  if (iskToCents(shares) <= 0n) {
    operationFailed(operationId, "shares_positive");
  }
  // The numeric(6, 2) column's own range, mirrored here for the same reason the
  // three checks above mirror the format and payout_participant_shares_ck: an
  // unbounded "10000" reaches Postgres as a raw numeric overflow and lands the
  // operator on error.tsx. assertSharesInRange in the service enforces this for
  // every caller; this copy is the one that can give the operator a page with
  // their roster still on it. Same constant, so the two cannot drift.
  if (iskToCents(shares) > MAX_SHARES_HUNDREDTHS) {
    operationFailed(operationId, "shares_range");
  }
  await getDb().transaction((dbtx) =>
    setParticipantShares(dbtx, actor, participantId, shares),
  );
  revalidateOperation(operationId);
}

/** Four inline editors for fields the create form no longer collects up
 *  front (name/date) plus the two that were always freeform (report link,
 *  notes) — one action per field, mirroring `setOperationName` /
 *  `setOccurredAt` / `setBattleReportUrl` / `setNotes`'s own one-function-
 *  per-field split in the service layer. Each redirects on its own input
 *  rejection through `operationFailed`, the same conversion every other input
 *  rejection on this page already goes through, and every service call is
 *  gated by `assertEditable` underneath — reachable only while `canEdit` is
 *  true on the page, same as `setCorpShareAction` below. */
export async function setNameAction(
  operationId: string,
  formData: FormData,
): Promise<void> {
  const actor = await requireOperatorAccount();
  const name = field(formData, "name").trim();
  if (!name) operationFailed(operationId, "name_required");
  await getDb().transaction((dbtx) => setOperationName(dbtx, actor, operationId, name));
  revalidateOperation(operationId);
}

export async function setOccurredAtAction(
  operationId: string,
  formData: FormData,
): Promise<void> {
  const actor = await requireOperatorAccount();
  const occurredAt = new Date(field(formData, "occurredAt"));
  if (Number.isNaN(occurredAt.getTime())) operationFailed(operationId, "date_invalid");
  await getDb().transaction((dbtx) =>
    setOccurredAt(dbtx, actor, operationId, occurredAt),
  );
  revalidateOperation(operationId);
}

export async function setBattleReportUrlAction(
  operationId: string,
  formData: FormData,
): Promise<void> {
  const actor = await requireOperatorAccount();
  const raw = field(formData, "battleReportUrl").trim() || null;
  // Same http(s)-only check `createOperationAction` runs, and for the same
  // reason: this is rendered as a plain `<a href>` on this very page, so a
  // `javascript:` or other scheme must never reach the database.
  if (raw) {
    let scheme: string;
    try {
      scheme = new URL(raw).protocol;
    } catch {
      operationFailed(operationId, "url_invalid");
    }
    if (scheme !== "http:" && scheme !== "https:") {
      operationFailed(operationId, "url_scheme");
    }
  }
  await getDb().transaction((dbtx) => setBattleReportUrl(dbtx, actor, operationId, raw));
  revalidateOperation(operationId);
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

/** The fifth operation-level field with an edit path. Same codes as the
 *  create form's share checks, so both surfaces reject identically; they
 *  land on different pages, which is why each page carries its own copy. */
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
