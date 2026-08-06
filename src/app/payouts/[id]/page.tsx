import { cache } from "react";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getDb } from "@/db";
import { getPayoutOperationDetail, listCharacterNames } from "@/services/payout-view";
import { Notice, RuleHead, Scroller, SiteHeader, Status } from "@/app/_components/ui";
import { brandProps } from "@/app/_components/brand-server";
import { Disclosure } from "@/app/_components/disclosure";
import { Submit } from "@/app/_components/submit";
import {
  ConfirmArmScope,
  ConfirmCost,
  ConfirmSubmit,
} from "@/app/_components/confirm-submit";
import { requirePayoutReader } from "../access";
import {
  addFlatPoolAction,
  addParticipantAction,
  deleteOperationAction,
  deletePoolAction,
  finalizeAction,
  markPaidAction,
  openInfoAction,
  removeParticipantAction,
  revertPaymentAction,
  setBattleReportUrlAction,
  setCorpShareAction,
  setItemPriceAction,
  setNameAction,
  setNotesAction,
  setOccurredAtAction,
  setParticipantExcludedAction,
  setParticipantSharesAction,
  setRosterAction,
  unlockAction,
} from "../actions";
import { DROPPED_REASONS, decodeDropped } from "../dropped";
import { OPERATION_ERRORS, lookupErrorMessage } from "../errors";
import { AppraiseForm } from "./appraise-form";
import { ClearStaleQuery } from "./clear-stale-query";
import { CopyAmountButton } from "./copy-amount-button";
import { InlineEdit } from "./inline-edit";
import { MarkPaidForm, PayFlow, RevertForm, type PayRow } from "./pay-flow";
import { copyAmountId } from "./pay-flow-ids";
import { PaymentHistory } from "./payment-history";
import { deriveRosterWarnings } from "./roster-warnings";
import type { PricingMode } from "@/core/pricing";
import { fmtIsk } from "@/app/_components/format-isk";

export const dynamic = "force-dynamic";

/**
 * The canonical 8-4-4-4-12 hex form, case-insensitively — the shape
 * `defaultRandom()` writes and every link in the app carries.
 *
 * Without this check a malformed id reaches the `uuid` column as a parameter
 * and postgres rejects the cast with 22P02, which surfaces as `error.tsx` —
 * "Something broke", an apology for a server fault, when the member simply
 * mistyped or followed a truncated link.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One detail lookup per request, shared by `generateMetadata` and the page
 * body below. React's `cache()` is request-scoped, and Next runs metadata and
 * render in the same request, so naming the operation in the tab title costs
 * no extra query — the second call is a cache hit.
 */
const loadDetail = cache(async (id: string) => {
  if (!UUID_RE.test(id)) return null;
  return getPayoutOperationDetail(getDb(), id);
});

/** Same trick for the guard: several queries, resolved once per request. */
const readAccess = cache(requirePayoutReader);

/**
 * Replaces a static `metadata` export, which could only ever say "Payout
 * operation" — including for an operation that isn't there, because a
 * segment-scoped `not-found.tsx` does not get to set the title and the page's
 * own metadata is applied even when the page throws.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const access = await readAccess();
  if (!access) return { title: "Payout operation" };
  const { id } = await params;
  const detail = await loadDetail(id);
  return { title: detail ? detail.operation.name : "No such operation" };
}

const PRICING_LABELS: Record<PricingMode, string> = {
  sell_best: "Sell (best)",
  sell_p05: "Sell (5th percentile)",
  buy_best: "Buy (best)",
  buy_p05: "Buy (5th percentile)",
};

/** The `<datalist>` the add-participant field points at. One per page, so a
 *  constant rather than a `useId` (this is a server component). */
const CHARACTER_LIST_ID = "known-character-names";

/** Below this many rows, `.scroller--tall`'s cap does more harm than good — see
 *  `.scroller--tall:has(.log--roster)` in globals.css, which gives this table
 *  its own chrome-relative cap rather than inheriting /admin/accounts'. */
const ROSTER_TALL_THRESHOLD = 20;

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The flat-pool form, factored out so it renders identically whether it is
 * the *only* loot control on the page (no pools yet) or nested under "Add
 * another paste" once one already exists — "Or enter a flat value" stays a
 * disclosure in both places (rare, secondary path), but it must not become
 * unreachable just because there happens to be no pool yet to add another
 * paste to.
 */
function FlatPoolDisclosure({ operationId }: { operationId: string }) {
  return (
    <Disclosure
      as="details"
      className="disc"
      summary="Or enter a flat value"
      ariaLabel="Or enter a flat value — a manual total for when triff can't price something"
    >
      <form action={addFlatPoolAction.bind(null, operationId)} className="form-stack">
        <label className="form-stack__field">
          Total value (ISK)
          <input
            className="field"
            type="number"
            step="0.01"
            min="0"
            name="totalValue"
            required
          />
        </label>
        <label className="form-stack__field">
          Note (required — why this number)
          <input className="field" name="notes" required />
        </label>
        <label className="form-stack__field">
          What was in it (optional)
          <textarea className="field" name="rawPaste" rows={3} />
        </label>
        <Submit className="btn">Add flat pool</Submit>
      </form>
    </Disclosure>
  );
}

export default async function PayoutOperationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; dropped?: string }>;
}) {
  const access = await readAccess();
  if (!access) redirect("/account");
  const { id } = await params;
  const { error, dropped } = await searchParams;
  const errorMessage = lookupErrorMessage(OPERATION_ERRORS, error);
  const droppedReport = decodeDropped(dropped);
  const detail = await loadDetail(id);
  if (!detail) notFound();
  const { operation, pools, participants, totalValue, corpAmount, locked } = detail;
  // Same reasoning the composer uses for its own date field: an operation
  // cannot be dated into the future.
  const today = new Date().toISOString().slice(0, 10);

  const nav = [
    { href: "/account", label: "Your account" },
    { href: "/payouts", label: "Payouts" },
    ...(access.isAdmin ? [{ href: "/admin/accounts", label: "Members" }] : []),
  ];
  // Mirrors `assertEditable` exactly, so an operator discovers the freeze by the
  // controls being absent rather than by a failed submit.
  const canEdit = access.isOperator && operation.status === "draft" && !locked;
  // Mirrors `unlockOperation`'s creator-or-admin check.
  const canUnlock =
    access.isOperator && (operation.createdBy === access.accountId || access.isAdmin);

  // null when there are more characters than the datalist cap — the field then
  // degrades to plain free text (see listCharacterNames).
  const characterNames = canEdit ? await listCharacterNames(getDb()) : null;

  const { duplicateUnresolvedNames, crossStateClashes } =
    deriveRosterWarnings(participants);

  const poolsWithUnresolvedItems = pools
    .map((pool, index) => ({
      index,
      unresolved: pool.items.filter((i) => i.priceSource === "unresolved"),
    }))
    .filter(({ unresolved }) => unresolved.length > 0);
  const totalUnresolvedItems = poolsWithUnresolvedItems.reduce(
    (sum, p) => sum + p.unresolved.length,
    0,
  );

  const owedParticipants = participants.filter((p) => p.paymentState !== "excluded");
  const paidParticipants = owedParticipants.filter((p) => p.paymentState === "paid");

  // What the pay flow needs, and nothing more: excluded rows are already out of
  // `owedParticipants`, so they cannot become a focus target by construction.
  // `fmtIsk` runs here rather than in the client component so money formatting
  // has one implementation.
  const payRows: PayRow[] = owedParticipants.map((p) => ({
    id: p.id,
    displayName: p.displayName,
    amountLabel: `${fmtIsk(p.amount)} ISK`,
    state: p.paymentState === "paid" ? "paid" : "unpaid",
  }));

  // Only the *first* payment is worth an arm step — see the original comment
  // this carries forward: `locked` (hasPayments) is permanent, so every later
  // "mark paid" is a click behind a door already shut.
  const firstPayment = !locked;

  // --- One gold control per state -----------------------------------------
  // The ledger has exactly one `.btn--primary` at a time, and which control it
  // is tracks how far along the operation is rather than being fixed to one
  // spot: no loot yet → appraising it is the only thing worth doing; loot but
  // no roster → setting the roster is; both present and still a draft →
  // finalizing is. Once finalized there is nothing left to promote — Unlock
  // and the payment controls are all deliberately plain grade, since none of
  // them is "the" next step the way the three above are.
  const primaryStage: "appraise" | "roster" | "finalize" | "none" = !canEdit
    ? "none"
    : pools.length === 0
      ? "appraise"
      : participants.length === 0
        ? "roster"
        : "finalize";

  // How much a roster replace would actually cost, named rather than counted
  // in the abstract: a participant is "edited" once its shares differ from
  // the `resolveRosterNames` default of "1" or it has been excluded — either
  // is state `setRosterAction`'s wholesale delete-and-reinsert would discard
  // with no way back (`setRoster`, services/payouts.ts:435-467).
  const editedParticipantCount = participants.filter(
    (p) => p.shares !== "1" || p.paymentState === "excluded",
  ).length;

  // --- What the Operation section holds ------------------------------------
  // The facts grid and the lifecycle control are independently conditional but
  // share one heading, so each is named rather than re-derived inline: the
  // heading has to render when *either* has something to show, and inlining
  // both tests into the JSX made that condition unreadable.
  const hasFacts = pools.length > 0 || participants.length > 0;
  // Only a flat pool is required to carry a note; an appraised one almost
  // never has any. Rendering the column unconditionally spends a full column
  // and its heading on nothing across the whole table in the common case.
  const anyPoolNotes = pools.some((p) => p.notes);
  const canFinalize = access.isOperator && operation.status === "draft";
  const canRelease =
    access.isOperator && operation.status === "finalized" && !locked && canUnlock;
  const showLifecycle = canFinalize || canRelease || (access.isOperator && locked);

  return (
    <>
      <SiteHeader items={nav} current="/payouts" section {...brandProps()} />
      <main id="main" tabIndex={-1} className="page">
        <div className="page__head">
          {canEdit ? (
            <h1>
              <InlineEdit
                action={setNameAction.bind(null, operation.id)}
                fieldName="name"
                value={operation.name}
                label="operation name"
              />
            </h1>
          ) : (
            <h1>{operation.name}</h1>
          )}
          <p className="page__lede">
            {/* Computed state, not prose: "prose is proportional, state is
                mono" applies to a plain ISO date as much as to a badge or an
                amount. */}
            {canEdit ? (
              <InlineEdit
                action={setOccurredAtAction.bind(null, operation.id)}
                fieldName="occurredAt"
                value={fmtDate(operation.occurredAt)}
                label="operation date"
                type="date"
                mono
                max={today}
              />
            ) : (
              <span className="mono">{fmtDate(operation.occurredAt)}</span>
            )}
            {operation.battleReportUrl && (
              <>
                {" · "}
                <a href={operation.battleReportUrl} target="_blank" rel="noreferrer">
                  battle report
                </a>
              </>
            )}
          </p>
          {/* The summary line the facts grid used to lead with, kept here
              unconditionally: "draft · 4.2b ISK · 0/14 paid" is the one-glance
              answer to "where does this stand", and it should not wait on
              there being enough content to earn a whole grid below it. */}
          <p className="dim mono">
            {operation.status === "finalized" ? "finalized" : "draft"}
            {locked && " · frozen"}
            {" · "}
            {fmtIsk(totalValue)} ISK
            {owedParticipants.length > 0 &&
              ` · ${paidParticipants.length}/${owedParticipants.length} paid`}
          </p>
        </div>

        {/* Clears `?error=`/`?dropped=` from the address bar once shown, so a
            later successful edit elsewhere on this page cannot re-render this
            same, by-then-stale notice — see the component's own docblock. */}
        <ClearStaleQuery />
        {errorMessage && <Notice tone="bad">{errorMessage}</Notice>}

        {droppedReport && (
          <Notice tone="warn">
            <span>
              <strong>
                {droppedReport.total} item{droppedReport.total === 1 ? "" : "s"} ignored
              </strong>{" "}
              — the rest of the paste was appraised and saved. Nothing listed here is in
              the pool. Re-paste anything that was meant to count.
              <br />
              <span className="dim">
                {droppedReport.sample
                  .map((d) => `${d.line} (${DROPPED_REASONS[d.reason]})`)
                  .join("; ")}
              </span>
              {droppedReport.total > droppedReport.sample.length && (
                <>
                  <br />
                  <span className="dim">
                    …and {droppedReport.total - droppedReport.sample.length} more.
                  </span>
                </>
              )}
            </span>
          </Notice>
        )}

        {/* One page-wide arm scope: at most one destructive/confirm control
            (a pool delete, a roster remove, a roster replace, mark-paid,
            finalize, unlock, revert, delete) can be armed at a time, regardless
            of which section it lives in — arming one used to leave whatever was
            armed in a different table's own scope silently primed. It opens
            here rather than at Loot because Finalize and Unlock now sit in the
            Operation section, and a confirm control outside the scope would
            throw for want of the context. */}
        <ConfirmArmScope>
          {/* --- Operation ----------------------------------------------- */}
          {(hasFacts || showLifecycle) && <RuleHead as="h2">Operation</RuleHead>}

          {/* The fuller facts grid does not lead the page anymore — the summary
              line above already answers "where does this stand" the instant the
              page loads. This block earns its place only once there is
              something to look up in it: an operation with no loot and no
              roster has nothing here worth a whole grid over the one-line
              summary already shown. */}
          {hasFacts && (
            <dl className="facts">
              <dt>Status</dt>
              <dd>
                <div className="stack">
                  {operation.status === "finalized" ? (
                    <Status tone="ok">finalized</Status>
                  ) : (
                    <Status tone="off">draft</Status>
                  )}
                  {locked && <Status tone="off">frozen</Status>}
                </div>
              </dd>
              <dt>Corp share</dt>
              <dd className="mono">
                {canEdit ? (
                  <InlineEdit
                    action={setCorpShareAction.bind(null, operation.id)}
                    fieldName="corpSharePct"
                    value={operation.corpSharePct}
                    displayValue={
                      <>
                        {operation.corpSharePct}%{" "}
                        <span className="dim">
                          ({fmtIsk(corpAmount)} ISK + remainder)
                        </span>
                      </>
                    }
                    label="corp share"
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                  />
                ) : (
                  <>
                    {operation.corpSharePct}%{" "}
                    <span className="dim">({fmtIsk(corpAmount)} ISK + remainder)</span>
                  </>
                )}
              </dd>
              <dt>Total loot</dt>
              <dd className="mono">{fmtIsk(totalValue)} ISK</dd>
            </dl>
          )}

          {/* Finalize and Unlock, beside the status they change rather than at
              the foot of the page under Notes and above Delete. Structurally a
              sibling of the <dl>, never a child of it: a <form> dropped between
              a <dt>/<dd> pair is invalid HTML the parser silently reshuffles —
              the same class of bug as the <p><form> nesting fixed in da8c7d0,
              which `expectNoFormInParagraph` in e2e/payouts.spec.ts guards. */}
          {showLifecycle && (
            <div className="lifecycle">
              {locked && (
                <p className="dim">
                  A payment has been recorded, so the loot pools, the roster, shares and
                  the corp share are fixed permanently. Reverting a payment does not
                  reopen editing — it corrects who has been paid, and nothing else. If the
                  wrong person was marked paid, revert them and pay the right one; both
                  work while frozen.
                </p>
              )}
              <div className="btn-row btn-row--tight">
                {canFinalize && (
                  <form action={finalizeAction.bind(null, operation.id)}>
                    <ConfirmSubmit
                      className={primaryStage === "finalize" ? "btn btn--primary" : "btn"}
                      label="Finalize"
                      confirmName="confirm finalize"
                      describedBy="finalize-cost"
                    />
                    <ConfirmCost id="finalize-cost" className="dim">
                      Closes the pools, roster and shares to editing. Reversible with
                      Unlock until the first payment is recorded, and permanent after
                      that.
                    </ConfirmCost>
                  </form>
                )}
                {/* Plain grade, and armed like its neighbours. Quiet made it
                  indistinguishable from the label register it sat beside — the
                  comment on `primaryStage` above already says Unlock is meant
                  to be plain, and the markup had drifted from it. It reopens
                  finalized financial state, which is the same weight as the
                  Finalize it undoes, so it arms rather than firing on one
                  press. The standing explanation that used to sit permanently
                  below it is now the cost sentence, which is what this
                  component exists to hold. */}
                {canRelease && (
                  <form action={unlockAction.bind(null, operation.id)}>
                    <ConfirmSubmit
                      className="btn"
                      label="Unlock"
                      confirmName="confirm unlock"
                      describedBy="unlock-cost"
                    />
                    <ConfirmCost id="unlock-cost" className="dim">
                      Reopens the pools, roster and shares to editing, until finalized
                      again or until the first payment is recorded.
                    </ConfirmCost>
                  </form>
                )}
              </div>
            </div>
          )}

          {/* --- Loot ---------------------------------------------------- */}
          <RuleHead
            as="h2"
            aside={<span className="dim mono">{fmtIsk(totalValue)} ISK</span>}
          >
            Loot
          </RuleHead>
          {canEdit && pools.length === 0 && (
            <>
              <AppraiseForm
                operationId={operation.id}
                primary={primaryStage === "appraise"}
              />
              <FlatPoolDisclosure operationId={operation.id} />
            </>
          )}
          {pools.length > 0 && (
            <>
              <Scroller label="Loot pools">
                <table className="log">
                  <thead>
                    <tr>
                      <th scope="col">#</th>
                      <th scope="col">Source</th>
                      <th scope="col" className="num">
                        Value
                      </th>
                      {anyPoolNotes && <th scope="col">Notes</th>}
                      <th scope="col">
                        <span className="visually-hidden">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {pools.map((pool, index) => (
                      <tr key={pool.id}>
                        <td className="mono nowrap">{index + 1}</td>
                        <td>
                          {pool.valuationSource === "appraised" ? (
                            <Status tone="ok">
                              appraised
                              {pool.pricingMode &&
                                ` · ${PRICING_LABELS[pool.pricingMode as PricingMode] ?? pool.pricingMode}`}
                            </Status>
                          ) : (
                            <Status tone="warn">flat (manual)</Status>
                          )}
                        </td>
                        <td className="mono nowrap num">{fmtIsk(pool.totalValue)} ISK</td>
                        {anyPoolNotes && <td>{pool.notes}</td>}
                        <td>
                          {canEdit && (
                            <form
                              action={deletePoolAction.bind(null, operation.id, pool.id)}
                            >
                              <ConfirmSubmit
                                className="btn btn--quiet btn--micro btn--danger-quiet"
                                armedClassName="btn btn--micro btn--danger"
                                label="delete"
                                restName={`delete pool ${index + 1}`}
                                confirmName={`confirm delete pool ${index + 1}`}
                              />
                            </form>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Scroller>

              {poolsWithUnresolvedItems.length > 0 && (
                <Notice tone="warn">
                  <span>
                    <strong>
                      {totalUnresolvedItems} item{totalUnresolvedItems === 1 ? "" : "s"}{" "}
                      priced at 0.00 across {poolsWithUnresolvedItems.length} pool
                      {poolsWithUnresolvedItems.length === 1 ? "" : "s"}
                    </strong>{" "}
                    — not found, or no market data for the chosen pricing. The pool total
                    is short by whatever they are worth.
                    <br />
                    <span className="dim">
                      {poolsWithUnresolvedItems
                        .map(
                          ({ index, unresolved }) =>
                            `Pool ${index + 1}: ${unresolved
                              .map((i) => `${i.name} ×${i.qty}`)
                              .join(", ")}`,
                        )
                        .join("; ")}
                    </span>
                  </span>
                </Notice>
              )}

              {poolsWithUnresolvedItems.length > 0 &&
                !canEdit &&
                operation.status === "finalized" &&
                !locked && (
                  <Notice tone="info">
                    {canUnlock ? (
                      <>
                        Some loot is still unpriced, so the total is short — but repricing
                        is closed while the operation is finalized. Unlock, in the
                        Operation block above, reopens it until it is finalized again.
                      </>
                    ) : (
                      <>
                        Some loot is still unpriced, so the total is short — but repricing
                        is closed while the operation is finalized. Only this
                        operation&apos;s creator or an admin can unlock it.
                      </>
                    )}
                  </Notice>
                )}

              {/* One editable table at the top level, not one disclosure per
                  pool: a pool's items used to hide behind "Pool N items (M)",
                  which is exactly the loot this section exists to show —
                  DESIGN.md's "scanning is the primary act" argues against
                  burying the thing being scanned. A pool header row names
                  which pool each block of items belongs to when there is more
                  than one. */}
              {pools.map(
                (pool, index) =>
                  pool.items.length > 0 && (
                    <div key={pool.id} className="pool-items">
                      {pools.length > 1 && <p className="dim mono">Pool {index + 1}</p>}
                      <Scroller label={`Pool ${index + 1} items`}>
                        <table className="log">
                          <thead>
                            <tr>
                              <th scope="col">Item</th>
                              <th scope="col">Qty</th>
                              <th scope="col" className="num">
                                Unit price
                              </th>
                              <th scope="col" className="num">
                                Line total
                              </th>
                              <th scope="col">Price source</th>
                            </tr>
                          </thead>
                          <tbody>
                            {pool.items.map((item) => (
                              <tr key={item.id}>
                                <td>{item.name}</td>
                                <td className="mono nowrap">{item.qty}</td>
                                <td className="mono nowrap num">
                                  {canEdit ? (
                                    <InlineEdit
                                      action={setItemPriceAction.bind(
                                        null,
                                        operation.id,
                                        item.id,
                                      )}
                                      fieldName="unitPrice"
                                      value={item.unitPrice}
                                      label={`unit price for ${item.name}`}
                                      type="number"
                                      step="0.01"
                                      min="0"
                                      fieldClassName="field field--money"
                                      standalone={false}
                                    />
                                  ) : (
                                    fmtIsk(item.unitPrice)
                                  )}
                                </td>
                                <td className="mono nowrap num">
                                  {fmtIsk(item.totalValue)} ISK
                                </td>
                                <td>
                                  {item.priceSource === "unresolved" ? (
                                    <Status tone="warn">unresolved</Status>
                                  ) : (
                                    <Status>{item.priceSource}</Status>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </Scroller>
                    </div>
                  ),
              )}

              {canEdit && (
                <Disclosure
                  as="details"
                  className="disc"
                  summary="Add another paste"
                  ariaLabel="Add another paste — appraise more loot, or enter a flat value"
                >
                  <div className="form-stack">
                    <AppraiseForm operationId={operation.id} primary={false} />
                    <FlatPoolDisclosure operationId={operation.id} />
                  </div>
                </Disclosure>
              )}
            </>
          )}

          {/* --- Split / Roster ------------------------------------------ */}
          <RuleHead
            as="h2"
            id="roster-heading"
            aside={
              owedParticipants.length > 0 && (
                <span className="dim mono">
                  {paidParticipants.length}/{owedParticipants.length}
                </span>
              )
            }
          >
            Split / Roster
          </RuleHead>
          {participants.length === 0 && canEdit && (
            <form
              action={setRosterAction.bind(null, operation.id)}
              className="form-stack"
            >
              <label className="form-stack__field">
                Roster paste (names separated by /)
                <textarea className="field" name="paste" rows={8} required />
              </label>
              <Submit className={primaryStage === "roster" ? "btn btn--primary" : "btn"}>
                Set roster
              </Submit>
            </form>
          )}
          {/* Additive by necessity, and reachable whether or not a roster
              exists yet: `setRosterAction` (above, and "Replace roster from a
              paste" below once a roster exists) deletes the whole roster and
              reinserts it, which would discard every share edit already made —
              see `addParticipant`'s own comment (services/payouts.ts:469-477).
              Demoted to a small disclosure rather than an always-open form,
              because pasting is the common path and adding one name at a time
              is the rare correction — but it must stay available even before
              the first paste, since it is the only way to build a roster one
              name at a time instead of all at once. */}
          {canEdit && (
            <Disclosure
              as="details"
              className="disc"
              summary="Add one participant"
              ariaLabel="Add one participant — the only way to add someone without discarding existing share edits"
              defaultOpen={participants.length === 0}
            >
              {/* The rationale moved off the summary and into the body. As a
                  summary it was a 79-character sentence sitting in a column of
                  two- and three-word controls, which made the disclosure read
                  as a paragraph with a "+" in front of it rather than as
                  something to open. It is still worth saying — it is the whole
                  reason this control exists beside the paste — so it is said
                  once the operator has opened the thing it describes. */}
              <p className="dim">
                The only way to add someone without discarding existing share edits.
                Pasting a roster replaces the whole thing.
              </p>
              <form
                action={addParticipantAction.bind(null, operation.id)}
                className="form-stack"
              >
                <label className="form-stack__field">
                  Character name
                  <input
                    className="field"
                    name="name"
                    list={characterNames ? CHARACTER_LIST_ID : undefined}
                    autoComplete="off"
                    required
                  />
                </label>
                {characterNames && (
                  <datalist id={CHARACTER_LIST_ID}>
                    {characterNames.map((n) => (
                      <option key={n} value={n} />
                    ))}
                  </datalist>
                )}
                <Submit className="btn">Add participant</Submit>
              </form>
            </Disclosure>
          )}
          {participants.length > 0 && (
            <>
              <PayFlow rows={payRows} headingId="roster-heading">
                <Scroller
                  label="Roster"
                  tall={participants.length > ROSTER_TALL_THRESHOLD}
                >
                  <table className="log log--dense log--sticky-head log--sticky-col log--roster">
                    <thead>
                      <tr>
                        <th scope="col">Name</th>
                        <th scope="col" className="num">
                          Shares
                        </th>
                        <th scope="col" className="num">
                          Amount
                        </th>
                        <th scope="col">State</th>
                        <th scope="col">
                          <span className="visually-hidden">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {participants.map((p) => (
                        <tr key={p.id}>
                          <td>
                            {/* Mono marker, not colour alone (WCAG 1.4.1): the
                              reader's own row is the one row on the whole
                              roster they came here specifically to find. */}
                            {p.accountId === access.accountId && (
                              <span className="mono dim" aria-hidden="true">
                                {"» "}
                              </span>
                            )}
                            {p.accountId === access.accountId && (
                              <span className="visually-hidden">(you) </span>
                            )}
                            {p.displayName}
                            {p.sourceCharacters.length > 1 && (
                              <span className="dim">
                                {" "}
                                ({p.sourceCharacters.join(", ")})
                              </span>
                            )}
                          </td>
                          <td className="num">
                            {canEdit ? (
                              <InlineEdit
                                action={setParticipantSharesAction.bind(
                                  null,
                                  operation.id,
                                  p.id,
                                )}
                                fieldName="shares"
                                value={p.shares}
                                label={`shares for ${p.displayName}`}
                                type="number"
                                step="0.01"
                                min="0.01"
                                fieldClassName="field field--micro"
                                standalone={false}
                              />
                            ) : (
                              <span className="mono">{p.shares}</span>
                            )}
                          </td>
                          {/* The figure alone. `copy amount` used to stack under
                            it inside this cell, which put a left-aligned
                            control (`.stack` sets `justify-items: start`) in a
                            right-aligned numeric column and cost the column the
                            one thing a column of money is for — a single
                            vertical to read down. The button is an action, so
                            it lives in the action cell with the other actions;
                            `.copy-result`'s width reservation was already
                            written for "a right-aligned row of buttons", which
                            is where it now actually is. */}
                          <td className="mono nowrap num">{fmtIsk(p.amount)} ISK</td>
                          <td>
                            <div className="stack">
                              {p.paymentState === "excluded" && (
                                <Status tone="off">excluded</Status>
                              )}
                              {p.paymentState === "unpaid" && <Status>unpaid</Status>}
                              {p.paymentState === "paid" && (
                                <Status tone="ok">paid</Status>
                              )}
                              <PaymentHistory
                                payments={p.payments}
                                participantName={p.displayName}
                              />
                            </div>
                          </td>
                          <td>
                            <div className="btn-row btn-row--tight btn-row--end">
                              {operation.status === "finalized" &&
                                p.paymentState !== "excluded" && (
                                  <>
                                    <CopyAmountButton
                                      id={copyAmountId(p.id)}
                                      amount={p.amount}
                                      participantName={p.displayName}
                                    />
                                    {access.canOpenInfo &&
                                      p.recipientCharacterId !== null && (
                                        <form
                                          action={openInfoAction.bind(
                                            null,
                                            operation.id,
                                            p.id,
                                          )}
                                        >
                                          <Submit
                                            className="btn btn--quiet btn--micro"
                                            pendingLabel="opening…"
                                            aria-label={`open info for ${p.displayName}`}
                                          >
                                            open info
                                          </Submit>
                                        </form>
                                      )}
                                    {p.paymentState !== "paid" && access.isOperator && (
                                      <MarkPaidForm
                                        action={markPaidAction.bind(
                                          null,
                                          operation.id,
                                          p.id,
                                        )}
                                        participantId={p.id}
                                        displayName={p.displayName}
                                        arm={firstPayment}
                                      />
                                    )}
                                    {p.paymentState === "paid" && access.isOperator && (
                                      <RevertForm
                                        action={revertPaymentAction.bind(
                                          null,
                                          operation.id,
                                          p.id,
                                        )}
                                        participantId={p.id}
                                        displayName={p.displayName}
                                      />
                                    )}
                                  </>
                                )}
                              {canEdit && (
                                <>
                                  <form
                                    action={setParticipantExcludedAction.bind(
                                      null,
                                      operation.id,
                                      p.id,
                                      !p.excluded,
                                    )}
                                  >
                                    <Submit
                                      className="btn btn--quiet btn--micro"
                                      aria-label={
                                        p.excluded
                                          ? `include ${p.displayName}`
                                          : `exclude ${p.displayName}`
                                      }
                                    >
                                      {p.excluded ? "include" : "exclude"}
                                    </Submit>
                                  </form>
                                  <form
                                    action={removeParticipantAction.bind(
                                      null,
                                      operation.id,
                                      p.id,
                                    )}
                                  >
                                    <ConfirmSubmit
                                      className="btn btn--quiet btn--micro btn--danger-quiet"
                                      label="remove"
                                      restName={`remove ${p.displayName}`}
                                      confirmName={`confirm remove ${p.displayName}`}
                                    />
                                  </form>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Scroller>
              </PayFlow>

              {duplicateUnresolvedNames.length > 0 && (
                <Notice tone="warn">
                  <span>
                    <strong>
                      {duplicateUnresolvedNames.length} unresolved name
                      {duplicateUnresolvedNames.length === 1 ? "" : "s"} appear
                      {duplicateUnresolvedNames.length === 1 ? "s" : ""} more than once
                    </strong>{" "}
                    — each is drawing a full share as a separate person. If they are the
                    same pilot, remove one before finalizing.
                    <br />
                    <span className="dim">{duplicateUnresolvedNames.join(", ")}</span>
                  </span>
                </Notice>
              )}
              {crossStateClashes.length > 0 && (
                <Notice tone="info">
                  <span>
                    <strong>
                      {crossStateClashes.length} name
                      {crossStateClashes.length === 1 ? "" : "s"} on this roster{" "}
                      {crossStateClashes.length === 1 ? "is" : "are"} both linked and
                      unlinked
                    </strong>{" "}
                    — one row is tied to an account, another under the same name is not,
                    and each is drawing a full share. They may be the same pilot whose
                    link landed after the roster was written, or two different people who
                    share a name. Check before finalizing.
                    <br />
                    <span className="dim">{crossStateClashes.join(", ")}</span>
                  </span>
                </Notice>
              )}

              {canEdit && (
                <Disclosure
                  as="details"
                  className="disc"
                  summary="Replace roster from a paste"
                  ariaLabel="Replace roster from a paste — discards the current roster and every share edit"
                >
                  <form
                    action={setRosterAction.bind(null, operation.id)}
                    className="form-stack"
                  >
                    <label className="form-stack__field">
                      Paste (names separated by /)
                      <textarea className="field" name="paste" rows={8} required />
                    </label>
                    {/* Plain grade, not quiet. This is the terminal submit of
                        a form the operator has just typed a paste into, and
                        neither of its two structural siblings is quiet: "Add
                        participant" is a plain `.btn`, and "Set roster" is
                        plain or `--primary` depending on the stage. `.btn--quiet`
                        is transparent and borderless, so in that slot it reads
                        as a caption under the textarea rather than the control
                        that sends it. `--danger-quiet` keeps the destructive
                        restraint (colour only) without spending the border the
                        affordance needs, which is the pairing "Delete
                        operation" already uses. */}
                    <ConfirmSubmit
                      className="btn btn--danger-quiet"
                      armedClassName="btn btn--danger"
                      label="Replace roster"
                      confirmName="confirm replace roster"
                      describedBy="replace-roster-cost"
                    />
                    <ConfirmCost id="replace-roster-cost" className="dim">
                      Replaces all {participants.length} participant
                      {participants.length === 1 ? "" : "s"}.{" "}
                      {editedParticipantCount > 0
                        ? `${editedParticipantCount} share edit${editedParticipantCount === 1 ? "" : "s"} will be lost.`
                        : "No share edits will be lost — nothing on the current roster has been touched yet."}
                    </ConfirmCost>
                  </form>
                </Disclosure>
              )}
            </>
          )}

          {/* --- Details --------------------------------------------------- */}
          <RuleHead as="h2">Details</RuleHead>
          {/* --wide because "Battle report" is the one label in the app that
              does not fit `.facts`' 6rem column: it wraps to two lines and
              leaves its own value hanging off the second, while the row it sits
              in has most of the page still empty to the right. */}
          <dl className="facts facts--wide">
            <dt>Battle report</dt>
            <dd>
              {canEdit ? (
                <InlineEdit
                  action={setBattleReportUrlAction.bind(null, operation.id)}
                  fieldName="battleReportUrl"
                  value={operation.battleReportUrl ?? ""}
                  displayValue={
                    operation.battleReportUrl ? (
                      <a
                        href={operation.battleReportUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {operation.battleReportUrl}
                      </a>
                    ) : (
                      <span className="dim">Not set</span>
                    )
                  }
                  label="battle report URL"
                  type="url"
                  required={false}
                  fieldClassName="field field--grow"
                />
              ) : operation.battleReportUrl ? (
                <a href={operation.battleReportUrl} target="_blank" rel="noreferrer">
                  {operation.battleReportUrl}
                </a>
              ) : (
                <span className="dim">Not set</span>
              )}
            </dd>
            <dt>Notes</dt>
            <dd>
              {canEdit ? (
                <InlineEdit
                  action={setNotesAction.bind(null, operation.id)}
                  fieldName="notes"
                  value={operation.notes ?? ""}
                  displayValue={operation.notes || <span className="dim">None</span>}
                  label="operation notes"
                  as="textarea"
                  required={false}
                  rows={3}
                />
              ) : (
                operation.notes || <span className="dim">None</span>
              )}
            </dd>
          </dl>

          {/* --- Delete operation --------------------------------------- */}
          {access.isAdmin && (
            <>
              <RuleHead as="h2">Delete operation</RuleHead>
              <div className="btn-row">
                <form
                  action={deleteOperationAction.bind(null, operation.id)}
                  data-navigates
                >
                  <ConfirmSubmit
                    className="btn btn--danger-quiet"
                    armedClassName="btn btn--danger"
                    label="Delete"
                    restName="Delete operation"
                    confirmName="confirm delete operation"
                    describedBy="delete-operation-cost"
                  />
                </form>
              </div>
              <ConfirmCost id="delete-operation-cost" className="dim">
                Permanently deletes this operation: {participants.length} roster row
                {participants.length === 1 ? "" : "s"} and {fmtIsk(totalValue)} ISK of
                recorded loot. Blocked only if a participant is currently marked paid;
                revert every payment first if so.
              </ConfirmCost>
            </>
          )}
        </ConfirmArmScope>
      </main>
    </>
  );
}
