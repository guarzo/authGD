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
  PayoutLockedError,
  addParticipant,
  createOperationWithContents,
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
import { encodeUnresolved } from "./unresolved";
import type { NewOperationErrorCode, OperationErrorCode } from "./errors";
import type { AppraisalResult } from "@/services/appraisal";
import { unresolvedRosterNames } from "./new/unresolved-roster";

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

/**
 * The one definition of what a battle report link is allowed to be: an
 * absolute http(s) URL, or nothing.
 *
 * The rule matters because the value is rendered as a plain `<a href>` on the
 * operation's own page, so a `javascript:` (or `data:`, or any other) scheme
 * reaching the database is stored XSS. `URL.protocol` is lowercase-normalized
 * by the URL spec, so an allowlist compare on it is not case-bypassable, and
 * anything `new URL` cannot parse at all — a bare `zkillboard.com`, say — is
 * not a link this can store either.
 *
 * Extracted rather than written twice. Both entry points need it — the create
 * form and the inline edit on the operation page — and both now RETURN the code
 * rather than redirecting, so the value the operator typed survives the
 * rejection (the loot paste beside the field in the composer's case, the field's
 * own text in the editor's). This returns the code and lets each caller shape it
 * into its own state type. When the two checks were written out separately, the
 * comment in each claiming to match the other went stale inside one change.
 *
 * Returns null when there is nothing to object to, including for a null or
 * empty value — the field is optional at both call sites.
 */
function battleReportUrlProblem(
  value: string | null,
): "url_invalid" | "url_scheme" | null {
  if (!value) return null;
  let scheme: string;
  try {
    scheme = new URL(value).protocol;
  } catch {
    return "url_invalid";
  }
  return scheme === "http:" || scheme === "https:" ? null : "url_scheme";
}

/**
 * The `<input type="date">` wire format, parsed strictly. Shared by the two
 * places an operation date arrives (`createOperationAction` and
 * `setOccurredAtAction`) for the same reason `battleReportUrlProblem` is
 * shared: two copies of a check drift.
 *
 * `new Date(...)` alone is not enough. It rejects "not-a-date" and month 13,
 * but it *normalizes* a day past the end of the month rather than refusing it
 * — `new Date("2026-02-30")` is 2026-03-02 — so a hand-built request (the
 * browser's own date picker cannot produce one) would store a different day
 * than it submitted, silently, on a record operators reconcile against their
 * own logs. Comparing the parsed UTC components back against the submitted
 * digits is what catches the rollover; the format guard in front of it is what
 * keeps locale-ish spellings like "2026-2-3" out, since those parse in local
 * time and would shift the stored day by a timezone.
 */
function parseYmd(raw: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const parsed = new Date(`${y}-${mo}-${d}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  if (
    parsed.getUTCFullYear() !== Number(y) ||
    parsed.getUTCMonth() + 1 !== Number(mo) ||
    parsed.getUTCDate() !== Number(d)
  ) {
    return null;
  }
  return parsed;
}

/** The composer's own state. `null` is `useActionState`'s initial value,
 *  matching `AppraiseActionState`'s own convention: `state === null` never
 *  renders a notice, whether that means "hasn't submitted yet" or "still
 *  pending".
 *
 *  Every rejection here RETURNS this rather than redirecting through a
 *  `?error=` query string, and that is the entire point of the composer: a
 *  loot paste runs hundreds of lines and a redirect cannot carry it, so
 *  losing the redirect is what keeps `useActionState` mounted with the
 *  operator's pastes still sitting in their textareas. `createFailed`, the
 *  echo-through-query-string helper the old two-field create form used, is
 *  gone — nothing else in this file needs it now that every path through
 *  this action returns instead.
 *
 *  There is no `ok: true` branch: a create that resolves every field
 *  succeeds unconditionally, whether or not the roster paste left a name
 *  unresolved. An unmatched pilot is an ordinary paste typo, not a
 *  refusal-worthy input — `createOperationAction` still creates the
 *  operation — but it is also not a reason to keep the operator on this
 *  page; the loot half of the same submit already reports its own paste
 *  problems on the destination page rather than the composer, via `dropped`
 *  in the query string (see `./dropped`), and the roster half now does the
 *  same via `unresolved` (see `./unresolved`). Both travel on the one
 *  redirect below, so a submit that hits both problems at once does not
 *  lose either report. */
export type CreateOperationState = { ok: false; code: NewOperationErrorCode } | null;

/**
 * Collects name, date, an optional battle report link, an optional loot paste
 * and an optional roster paste in
 * one submit, landing on a fully-populated operation — see
 * `createOperationWithContents` (src/services/payouts.ts) for what "fully
 * populated" does inside the one transaction this opens.
 *
 * Order matters and is deliberate:
 *
 *   1. validate name/date/battle-report-scheme — the required fields plus the
 *      one optional field with a security-relevant shape, all checked before
 *      any network call so a typo or a bad scheme never triggers an appraisal.
 *   2. appraise the loot paste (network: triff/ESI), OUTSIDE any transaction,
 *      the same rule `addAppraisedPoolAction` already follows and for the
 *      same reason — a slow upstream must never hold a row lock.
 *   3. parse the roster paste (pure, no I/O).
 *   4. ONE transaction: `resolveRosterNames` (a DB read) then
 *      `createOperationWithContents`, mirroring `setRosterAction`'s own
 *      resolve-then-set order.
 *
 * Appraisal runs BEFORE the transaction opens, and its failure returns
 * immediately without touching the database at all — no operation is
 * created, empty or otherwise. That is the point of running it first: a
 * paste that cannot be priced must not leave an orphaned shell behind for the
 * operator to notice and delete later.
 *
 * `redirect()` throws NEXT_REDIRECT and must never sit inside a `try` — an
 * enclosing `catch` would swallow it and the operator would land on
 * error.tsx instead of the new operation. The transaction call below is
 * therefore NOT wrapped in try/catch: nothing it can throw is meant to
 * become `{ ok: false }` (an appraisal failure is caught earlier, before the
 * transaction ever opens), so anything it does throw is a genuine fault and
 * belongs on error.tsx. See `addAppraisedPoolAction`'s own comment, which
 * solved this same problem first.
 *
 * The transaction commits unconditionally into a `redirect()` — see
 * `CreateOperationState`'s own doc for why there is no longer a branch here
 * that stays on this page. Both `dropped` (loot) and `unresolved` (roster)
 * are computed before the redirect and both ride the same URL when either or
 * both are non-empty, mirroring how `addAppraisedPoolAction` already carries
 * `dropped` onto its own redirect target.
 */
export async function createOperationAction(
  _prevState: CreateOperationState,
  formData: FormData,
): Promise<CreateOperationState> {
  const actor = await requireOperatorAccount();
  const name = field(formData, "name").trim();
  if (!name) return { ok: false, code: "name_required" };
  const occurredAt = parseYmd(field(formData, "occurredAt"));
  if (occurredAt === null) return { ok: false, code: "date_invalid" };

  // Checked before any network call, alongside name and date, so a bad scheme
  // never triggers an appraisal only to be thrown away.
  const battleReportUrl = field(formData, "battleReportUrl").trim() || null;
  const urlProblem = battleReportUrlProblem(battleReportUrl);
  if (urlProblem) return { ok: false, code: urlProblem };

  const lootPaste = field(formData, "lootPaste").trim();
  const rosterPaste = field(formData, "rosterPaste").trim();

  let appraisalInput:
    | {
        rawPaste: string;
        pricingMode: PricingMode;
        stationId: number | null;
        regionId: number | null;
        appraisal: AppraisalResult;
      }
    | undefined;
  // Same "dropped lines travel through the query string" mechanism
  // `addAppraisedPoolAction` uses, carried onto the SUCCESS redirect below so
  // the ledger the operator lands on can report them.
  let droppedParam: string | null = null;

  if (lootPaste) {
    const cfg = getConfig();
    const esi = createEsiClient({ userAgent: `authgd/0.1.0 (${cfg.esiContact})` });
    const triff = createTriffClient();
    try {
      const appraisal = await appraiseLoot(
        lootPaste,
        {
          pricingMode: APPRAISAL_PRICING_MODE,
          stationId: APPRAISAL_STATION_ID,
          regionId: undefined,
        },
        { esi, triff },
      );
      appraisalInput = {
        rawPaste: lootPaste,
        pricingMode: APPRAISAL_PRICING_MODE,
        stationId: APPRAISAL_STATION_ID,
        regionId: null,
        appraisal,
      };
      if (appraisal.dropped.length > 0) {
        droppedParam = encodeDropped(appraisal.dropped);
      }
    } catch (err) {
      if (err instanceof TriffError || err instanceof EsiError) {
        // Nothing was created — see this function's own docblock for why
        // appraisal runs before the transaction ever opens.
        return { ok: false, code: "appraisal_failed" };
      }
      throw err;
    }
  }

  const names = rosterPaste ? parseRosterPaste(rosterPaste) : [];

  // Read back out of the transaction closure below, the same way
  // `appraisalInput`/`droppedParam` above are captured across an `await`
  // boundary before the redirect that follows.
  let unresolvedNames: string[] = [];

  const { id } = await getDb().transaction(async (dbtx) => {
    const rosterEntries =
      names.length > 0 ? await resolveRosterNames(dbtx, names) : undefined;
    // See `unresolvedRosterNames`'s own doc: an entry with no matching
    // character is not refused, only reported, so this is a read of what
    // `resolveRosterNames` already decided rather than a second check.
    unresolvedNames = rosterEntries ? unresolvedRosterNames(rosterEntries) : [];
    return createOperationWithContents(dbtx, actor, {
      name,
      occurredAt,
      battleReportUrl,
      // A deployment-wide default, not a per-operation one — same source
      // the old create action read it from.
      corpSharePct: getConfig().payoutCorpSharePct,
      appraisal: appraisalInput,
      rosterEntries,
    });
  });
  revalidatePath("/payouts");
  // Same "report through the query string, unconditionally" mechanism
  // `droppedParam` above already uses, for the roster half of the same
  // submit — see `CreateOperationState`'s own doc.
  const unresolvedParam =
    unresolvedNames.length > 0 ? encodeUnresolved(unresolvedNames) : null;
  const query = new URLSearchParams();
  if (droppedParam) query.set("dropped", droppedParam);
  if (unresolvedParam) query.set("unresolved", unresolvedParam);
  const qs = query.toString();
  redirect(qs ? `/payouts/${id}?${qs}` : `/payouts/${id}`);
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
 * on purpose. Two different client components render this, and each treats
 * `ok: true` as "nothing to echo" for its own reason: `InlineEdit` (editing an
 * existing field) falls back to the current server value, so a successful
 * save is never left showing a value that merely resembles what was
 * committed — it shows what the reload actually says. `AddParticipantForm`
 * (adding a new one, no server value to fall back to) instead clears its own
 * controlled input in a success effect; see that component's docblock. Both
 * read `state.value` only on the `ok: false` branch.
 */
export type StringFieldEditState =
  { ok: true } | { ok: false; code: OperationErrorCode; value: string } | null;

/**
 * `addFlatPoolAction`'s own twin of `StringFieldEditState` — a flat pool has
 * no single field to echo back, so this carries only the rejection `code`,
 * not the three submitted strings. `useActionState` still keeps this
 * function's caller (`FlatPoolForm`) mounted across a rejection the same way
 * `StringFieldEditState`'s consumers do, but the field values that survive
 * the rejection now come from `FlatPoolForm`'s own controlled state, not from
 * this state being echoed back — see that component's docblock. An earlier
 * version of this type carried `totalValue`/`notes`/`rawPaste` for exactly
 * the restore job the controlled inputs now do themselves; kept as
 * `{code}`-only rather than removed entirely, because the rejection still has
 * to say which of the three fields is wrong.
 */
export type FlatPoolEditState =
  { ok: true } | { ok: false; code: OperationErrorCode } | null;

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
    return { ok: false, code: "note_required" };
  }
  // <input type="number"> accepts scientific notation like "1e5" client-side;
  // iskToCents' regex rejects it, but let this action fail with the same
  // readable message the other numeric fields above use, rather than relying
  // solely on addFlatPool's deeper (also correct) check.
  //
  // No leading minus, matching setItemPriceAction below. addFlatPool rejects a
  // negative total too, but by throwing -- which reaches the error boundary
  // and takes the operator straight to it instead of leaving them on this
  // form to fix the number. Rejecting here keeps them on the form, with
  // `FlatPoolForm`'s controlled inputs — not this state — holding what they
  // typed.
  if (!/^\d+(\.\d{1,2})?$/.test(totalValue)) {
    return { ok: false, code: "total_invalid" };
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

/** Four editors for fields the create form no longer collects up front
 *  (name/date) plus the two that were always freeform (report link, notes) —
 *  one action per field, mirroring `setOperationName` / `setOccurredAt` /
 *  `setBattleReportUrl` / `setNotes`'s own one-function-per-field split in the
 *  service layer. The first three are `InlineEdit` editors and return
 *  `StringFieldEditState` on their own input rejection rather than redirecting
 *  through `operationFailed`: that redirect could carry a code but never the
 *  value that produced it, which is the defect that type exists to fix (see its
 *  docblock). `setNotesAction` is the odd one out and stays `Promise<void>` —
 *  #129 moved notes out of `InlineEdit` into a standing textarea
 *  (`[id]/notes-form.tsx`) that owns its own state, and there is no such thing
 *  as a malformed note for it to echo back. Every service call is gated by
 *  `assertEditable` underneath — reachable only while `canEdit` is true on the
 *  page. */
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
  const occurredAt = parseYmd(raw);
  if (occurredAt === null) {
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
  const raw = field(formData, "battleReportUrl").trim() || null;
  const problem = battleReportUrlProblem(raw);
  if (problem) return { ok: false, code: problem, value: raw ?? "" };
  await getDb().transaction((dbtx) => setBattleReportUrl(dbtx, actor, operationId, raw));
  revalidateOperation(operationId);
  return { ok: true };
}

/**
 * Saves the operation's notes from the always-open textarea on the detail
 * page (`[id]/notes-form.tsx`).
 *
 * The `PayoutLockedError` catch is a deliberate exception to this file's own
 * rule that lifecycle errors belong on error.tsx (see `revertPaymentAction`).
 * That rule holds because no lifecycle error there has anything the operator
 * typed at stake. This one does: the notes textarea sits open on the page for
 * as long as the operation is editable, so an operator can be a paragraph into
 * it when a second tab, or another operator, finalizes underneath them.
 * `canEdit` narrows that window and cannot close it. Uncaught,
 * `assertEditable`'s throw lands on error.tsx, which apologizes for a server
 * fault we did not have and tells them nothing about why their text is gone.
 * Redirecting says what actually happened.
 *
 * The text is lost either way — that is what the freeze means, and pretending
 * otherwise would mean holding an edit against an operation that is closed to
 * edits. What changes is that the operator learns the operation is now
 * finalized instead of being told we broke.
 *
 * A redirect at all makes this the last `operationFailed` caller among the
 * field editors: the input rejections all return `StringFieldEditState` now, so
 * the only thing left that navigates from this group is a freeze, which is not
 * something the operator can retype their way out of. `operationFailed`
 * redirects and `redirect()` works by throwing, so it must stay in the catch
 * rather than the try.
 */
export async function setNotesAction(
  operationId: string,
  formData: FormData,
): Promise<void> {
  const actor = await requireOperatorAccount();
  const notes = field(formData, "notes").trim() || null;
  try {
    await getDb().transaction((dbtx) => setNotes(dbtx, actor, operationId, notes));
  } catch (err) {
    if (err instanceof PayoutLockedError) operationFailed(operationId, "locked");
    throw err;
  }
  revalidateOperation(operationId);
}

/** The corp share is set once per deployment (a config default), not once per
 *  operation, so this editor sits in the facts grid rather than anywhere an
 *  operator is led to during a normal payout — but it is reachable, and #124
 *  put it back on the page after an earlier pass had removed it. Returns
 *  `StringFieldEditState` like every other `InlineEdit` action: a share typed
 *  as `12,5` or `120` has to stay on screen next to the message saying what
 *  is wrong with it, which is the whole point of that type.
 *
 *  `share_format` / `share_range` in `errors.ts` are therefore reachable
 *  again — the docblock there listing them alongside the appraisal backstops
 *  as dead is describing the window between those two changes. */
export async function setCorpShareAction(
  operationId: string,
  _prevState: StringFieldEditState,
  formData: FormData,
): Promise<StringFieldEditState> {
  const actor = await requireOperatorAccount();
  const corpSharePct = field(formData, "corpSharePct").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(corpSharePct)) {
    return { ok: false, code: "share_format", value: corpSharePct };
  }
  if (Number(corpSharePct) > 100) {
    return { ok: false, code: "share_range", value: corpSharePct };
  }
  await getDb().transaction((dbtx) =>
    setCorpSharePct(dbtx, actor, operationId, corpSharePct),
  );
  revalidateOperation(operationId);
  return { ok: true };
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
 * conversion drew across this file: input rejections are answered where the
 * operator is standing (as `?error=` once, as returned state now), and
 * everything else belongs on error.tsx. This action has no input to reject.
 */
export async function revertPaymentAction(
  operationId: string,
  participantId: string,
): Promise<void> {
  const actor = await requireOperatorAccount();
  await getDb().transaction((dbtx) => revertPayment(dbtx, actor, participantId));
  revalidateOperation(operationId);
}
