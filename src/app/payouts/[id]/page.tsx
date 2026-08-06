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
  deleteOperationAction,
  deletePoolAction,
  finalizeAction,
  markPaidAction,
  openInfoAction,
  removeParticipantAction,
  revertPaymentAction,
  setBattleReportUrlAction,
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
import { AddParticipantForm } from "./add-participant-form";
import { AppraiseForm } from "./appraise-form";
import { ClearStaleQuery } from "./clear-stale-query";
import { CopyAmountButton } from "./copy-amount-button";
import { FlatPoolForm } from "./flat-pool-form";
import { InlineEditField } from "./inline-edit-field";
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
 *
 * Postgres's own parser is looser than this regex. Measured against a `::uuid`
 * cast on the test database: it also accepts `{...}` braces, no hyphens at
 * all, and hyphens after any group of four. Those forms are deliberately
 * *not* accepted here. They cannot be produced by this app or by a link it
 * renders, so accepting them would only widen the surface; and being narrower
 * than the database fails toward the 404, which is the safe direction. Upper
 * case is the one divergence worth allowing, because postgres normalizes it
 * and the row would genuinely match.
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
 *
 * The guard runs first here as it does in the page body: metadata resolves
 * before render, so without it an id supplied by someone who cannot read
 * payouts would still be looked up.
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

/** Every code an action on this page can redirect with, and the copy for each,
 *  lives in `../errors` — with the type that stops those actions emitting one
 *  the map has no entry for. Its `share_format` / `share_range` wording is
 *  deliberately not the create form's; `../errors` says why. */

/** Below this many rows, `.scroller--tall`'s cap (globals.css, tuned against
 *  /admin/accounts' ~50-row table) does more harm than good: it clips a row
 *  mid-height inside a page that still has hundreds of pixels of vertical
 *  slack below it, for a sticky header that had nothing to scroll over in the
 *  first place. A typical roster is a dozen names; 20 is comfortably above
 *  that and still short of where an un-capped table would start crowding the
 *  Finalize control off screen. */
const ROSTER_TALL_THRESHOLD = 20;

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
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
  // Same reasoning as the create form's own `max`: an operation cannot be
  // dated into the future, and the date input enforces that client-side the
  // same way `/payouts/new` does.
  const today = new Date().toISOString().slice(0, 10);

  const nav = [
    { href: "/account", label: "Your account" },
    { href: "/payouts", label: "Payouts" },
    ...(access.isAdmin ? [{ href: "/admin/accounts", label: "Members" }] : []),
  ];
  // Mirrors `assertEditable` exactly, so an operator discovers the freeze by the
  // controls being absent rather than by a failed submit. Both halves matter:
  // finalizing freezes the numbers (unlock reopens them), and a payment freezes
  // them permanently. Drifting from the service check here would put buttons on
  // screen that can only reject.
  const canEdit = access.isOperator && operation.status === "draft" && !locked;
  // Mirrors `unlockOperation`'s creator-or-admin check. Unlock reopens someone
  // else's committed numbers, so it is not shown to every operator.
  const canUnlock =
    access.isOperator && (operation.createdBy === access.accountId || access.isAdmin);

  // null when there are more characters than the datalist cap — the field then
  // degrades to plain free text (see listCharacterNames).
  const characterNames = canEdit ? await listCharacterNames(getDb()) : null;

  // A name with no accountId is an unresolved roster entry (resolveRosterNames
  // never dedupes those against each other, on purpose — see its own comment).
  // `addParticipant` refuses a second unresolved row under a name already on
  // the roster, but a roster written before that guard existed can still
  // carry the pair, so the page keeps warning about it as a backstop. It also
  // warns about a second clash the service deliberately does NOT refuse — a
  // resolved row and an unresolved row sharing a name — because the resolved
  // row carries its own accountId and is never ambiguous downstream. See
  // `deriveRosterWarnings` for the full reasoning on both.
  const { duplicateUnresolvedNames, crossStateClashes } =
    deriveRosterWarnings(participants);

  // An unresolved item priced at 0.00 is the one thing on this page an
  // operator MUST see before finalizing: it means the total is quietly low
  // and everyone is about to be underpaid. This used to render one `Notice`
  // per affected pool (N pools with unresolved items produced N alarm
  // blocks); collapsed here into a single page-level list so the notice
  // below renders once regardless of how many pools it spans. Naming the
  // items, not just a count, is the part that actually matters — a bare
  // count doesn't tell you whether it's a junk module or the faction
  // battleship.
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

  // Same semantics as the list page's paidCount (payout-view.ts): an excluded
  // row is owed nothing and drops out of the denominator too, so an
  // all-excluded roster reads 0/0 rather than 0/N.
  const owedParticipants = participants.filter((p) => p.paymentState !== "excluded");
  const paidParticipants = owedParticipants.filter((p) => p.paymentState === "paid");

  // Only the *first* payment is worth an arm step. Recording one is what shuts
  // the door permanently — `locked` (hasPayments) makes the operation
  // un-editable and un-unlockable from then on (Recalculation safety,
  // mechanism 3), and this task's revert deliberately does NOT reopen it.
  // Every later "mark paid" is a click behind a door already shut, so gating
  // those would be friction with nothing behind it.
  //
  // Derived from `locked` rather than from "somebody is currently paid":
  // reverting the only payment leaves the operation frozen, because
  // `hasPayments` counts payment rows and a reverted payment still left one.
  // Keying the arm on current paid-ness would re-arm after a full revert.
  const firstPayment = !locked;

  return (
    <>
      <SiteHeader items={nav} current="/payouts" section {...brandProps()} />
      <main id="main" tabIndex={-1} className="page">
        <div className="page__head">
          <h1>{operation.name}</h1>
          <p className="page__lede">
            {/* Computed state, not prose: "prose is proportional, state is
                mono" applies to a plain ISO date as much as to a badge or an
                amount. The link and the separator around it stay proportional. */}
            <span className="mono">{fmtDate(operation.occurredAt)}</span>
            {operation.battleReportUrl && (
              <>
                {" · "}
                <a href={operation.battleReportUrl} target="_blank" rel="noreferrer">
                  battle report
                </a>
              </>
            )}
          </p>
        </div>

        {/* Clears `?error=`/`?dropped=` from the address bar once shown, so a
            later successful edit elsewhere on this page cannot re-render this
            same, by-then-stale notice — see the component's own docblock. */}
        <ClearStaleQuery />
        <Notice tone="bad">{errorMessage}</Notice>

        {/* "items", not "lines": parseLootPaste sums by item name before it
            decides what to drop, so one entry is one item quoted from the line
            it first appeared on, and the count can be smaller than the number
            of raw lines behind it. */}
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

        <RuleHead as="h2">Operation</RuleHead>
        <dl className="facts">
          <dt>Status</dt>
          <dd>
            <div className="stack">
              {operation.status === "finalized" ? (
                <Status tone="ok">finalized</Status>
              ) : (
                <Status tone="off">draft</Status>
              )}
              {/* Frozen (a payment recorded, every number fixed for good) used
                  to be a permanent `warn` Notice below this grid. That read as
                  an alarm on a workflow's successful terminal state — DESIGN.md's
                  "nothing reads as punishment" applies here as much as it does to
                  a tier or a dead token — and it rendered for every reader
                  regardless of role, so a member checking their own share read
                  editing rules ("Unlock reopens…") that never applied to them;
                  they cannot edit this page either way. A neutral Status token
                  states the fact to everyone in `--ink-dim`; the editing-rules
                  prose worth keeping for an operator moved to a `.dim` sentence
                  beside the roster's payment controls, gated on
                  `access.isOperator`, below. */}
              {locked && <Status tone="off">frozen</Status>}
            </div>
          </dd>
          <dt>Name</dt>
          <dd>{operation.name}</dd>
          <dt>Date</dt>
          <dd className="mono">{fmtDate(operation.occurredAt)}</dd>
          <dt>Battle report</dt>
          <dd>
            {/* The clickable link is worth keeping for a reader, but for an
                operator it is the second copy of the same URL on this page —
                the lede above already carries it. Editing lives in the
                disclosure below rather than here. */}
            {operation.battleReportUrl ? (
              <a href={operation.battleReportUrl} target="_blank" rel="noreferrer">
                {operation.battleReportUrl}
              </a>
            ) : (
              <span className="dim">Not set</span>
            )}
          </dd>
          <dt>Corp share</dt>
          <dd className="mono">
            {/* This used to also carry an inline editor here — an operator who
                accepted the create form's default committed the whole roster
                to a percentage with no way back, so the correction path sat
                inside the fact it corrected. The user has since decided corp
                share is set once per deployment rather than per operation, so
                the control is gone; this is now a plain fact, derived the same
                way. `setCorpShareAction` and the column it writes are
                unchanged and still exercised by services/payouts.ts's own
                tests — see that action's comment for why it stays reachable
                with no caller on this page. */}
            {fmtIsk(corpAmount)} ISK{" "}
            <span className="dim">({operation.corpSharePct}% + remainder)</span>
          </dd>
          <dt>Total loot</dt>
          <dd className="mono">{fmtIsk(totalValue)} ISK</dd>
          {/* Unlike the facts above, this row itself is conditional rather
              than always-rendered-with-a-placeholder: a reader whose operation
              has no notes gets no empty "Notes" label pointing at nothing. An
              operator who wants to add a first note reaches the textarea
              through "Edit details" below regardless of whether one exists
              yet, so this row does not need the always-present-while-editable
              exception it used to carry. */}
          {operation.notes && (
            <>
              <dt>Notes</dt>
              <dd>{operation.notes}</dd>
            </>
          )}
        </dl>

        {canEdit && (
          // Name, Date, Battle report and Notes used to render four
          // always-open forms directly in the facts grid above — permanently
          // expanded editors for values that were either just typed on the
          // create screen or rarely change again. The grid's job is "what is
          // true right now?" (PRODUCT.md's "state before action"); editing is
          // the rare case, so it collapses behind one disclosure instead.
          // Each field keeps its own form and its own server action
          // (setNameAction / setOccurredAtAction / setBattleReportUrlAction /
          // setNotesAction) rather than merging into one submit, so the four
          // distinct audit rows each action writes stay four distinct audit
          // rows.
          <Disclosure
            summary="Edit details"
            ariaLabel="Edit details — operation name, date, battle report link, and notes"
          >
            <div className="form-stack">
              <div className="form-stack__field">
                <label htmlFor="detail-name">Operation name</label>
                <InlineEditField
                  action={setNameAction.bind(null, operation.id)}
                  name="name"
                  serverValue={operation.name}
                  inputProps={{
                    id: "detail-name",
                    className: "field field--grow",
                    required: true,
                  }}
                  submitAriaLabel="save operation name"
                />
              </div>
              <div className="form-stack__field">
                <label htmlFor="detail-date">Operation date</label>
                <InlineEditField
                  action={setOccurredAtAction.bind(null, operation.id)}
                  name="occurredAt"
                  serverValue={fmtDate(operation.occurredAt)}
                  inputProps={{
                    id: "detail-date",
                    className: "field mono",
                    type: "date",
                    max: today,
                    required: true,
                  }}
                  submitAriaLabel="save operation date"
                />
              </div>
              <div className="form-stack__field">
                <label htmlFor="detail-battle-report">Battle report URL</label>
                <InlineEditField
                  action={setBattleReportUrlAction.bind(null, operation.id)}
                  name="battleReportUrl"
                  serverValue={operation.battleReportUrl ?? ""}
                  inputProps={{
                    id: "detail-battle-report",
                    className: "field field--grow",
                    type: "url",
                  }}
                  submitAriaLabel="save battle report URL"
                />
              </div>
              <form
                action={setNotesAction.bind(null, operation.id)}
                className="form-stack__field"
              >
                <label htmlFor="detail-notes">Operation notes</label>
                <textarea
                  id="detail-notes"
                  className="field"
                  name="notes"
                  rows={3}
                  maxLength={500}
                  defaultValue={operation.notes ?? ""}
                />
                <Submit className="btn btn--micro" aria-label="save operation notes">
                  save
                </Submit>
              </form>
            </div>
          </Disclosure>
        )}

        {/* The Finalize/Unlock control row sits below the participants table,
            after the numbers it acts on rather than heading them — see the
            comment there. */}

        <RuleHead
          as="h2"
          aside={<span className="dim mono">{fmtIsk(totalValue)} ISK</span>}
        >
          Loot pools
        </RuleHead>
        {canEdit && (
          // Used to sit below this table, collapsed once there was something
          // to bury (`defaultOpen={pools.length === 0}`) — backwards for the
          // primary workflow, which is "paste loot, then look at what it
          // produced": a fresh operation's first action is this paste, so it
          // now sits ahead of the table it fills, still open by default while
          // there is nothing yet to look at.
          <Disclosure
            summary="Add loot"
            ariaLabel="Add loot — paste for triff to appraise, or a flat-valued exception"
            defaultOpen={pools.length === 0}
          >
            <div className="form-stack">
              {/* The paste is the one true submit of this panel — see
                  AppraiseForm's own `.btn--primary`. The flat pool used to
                  share this open panel as a second, equally-weighted submit;
                  it is now its own nested, never-open disclosure below, kept
                  as a deliberate exception for when triff can't reach a
                  number rather than a co-equal path an operator has to choose
                  between on every visit. */}
              <AppraiseForm operationId={operation.id} />

              <Disclosure
                summary="Or enter a flat value"
                ariaLabel="Or enter a flat value — a manual total for when triff can't price something"
              >
                <FlatPoolForm operationId={operation.id} />
              </Disclosure>
            </div>
          </Disclosure>
        )}
        <Scroller label="Loot pools">
          <table className="log">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Source</th>
                <th scope="col" className="num">
                  Value
                </th>
                <th scope="col">Notes</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            {/* Renders no element of its own, so the table keeps its
                thead/tbody structure while every delete button in it shares one
                arm state. */}
            <ConfirmArmScope>
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
                    <td>{pool.notes}</td>
                    <td>
                      {canEdit && (
                        <form action={deletePoolAction.bind(null, operation.id, pool.id)}>
                          {/* Deleting a pool drops its whole appraisal — the
                            paste, every priced line, the lot — and the only
                            way back is to re-paste and re-price. Irreversible,
                            so it gets revert's grade on confirm (full
                            `.btn--danger`, not the quiet grade `remove` keeps),
                            and a real per-row subject name — the previous
                            literal "delete pool" on every row named nothing,
                            which is why it still has to start with the visible
                            label to keep the WCAG 2.5.3 match. */}
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
                {pools.length === 0 && (
                  <tr>
                    <td className="log__empty" colSpan={5}>
                      <span className="log__empty-text">No loot recorded yet.</span>
                    </td>
                  </tr>
                )}
              </tbody>
            </ConfirmArmScope>
          </table>
        </Scroller>

        {/* Below the Scroller rather than inside a pool row's cell: a warning
            nested in a horizontally-scrolling cell is unreachable at 320px
            (the same reason the account page's remediation prose sits outside
            its Scroller, and the item disclosure just below is too).

            This used to be two Notices repeated once per affected pool — one
            for genuinely unresolved items, one for a resolved item whose
            unit price rounds to 0.00 for display while the line total is
            real. The second one is gone entirely: its own copy said "the
            line total is real and already counted in the pool", which is an
            alarm block stating that nothing is wrong, and the item table
            below already carries both the unit price and the line total for
            exactly this reason. Only the first — genuinely unpriced, so the
            total is short — survives, now collapsed into one page-level
            notice naming every affected pool rather than one block per
            pool. */}
        {poolsWithUnresolvedItems.length > 0 && (
          <Notice tone="warn">
            <span>
              <strong>
                {totalUnresolvedItems} item{totalUnresolvedItems === 1 ? "" : "s"} priced
                at 0.00 across {poolsWithUnresolvedItems.length} pool
                {poolsWithUnresolvedItems.length === 1 ? "" : "s"}
              </strong>{" "}
              — not found, or no market data for the chosen pricing. The pool total is
              short by whatever they are worth.
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

        {/* This notice is something an operator would reopen an operation to
            fix; the item table below is where they'd do it. */}
        {poolsWithUnresolvedItems.length > 0 &&
          !canEdit &&
          operation.status === "finalized" &&
          !locked && (
            // The warning above is visible to everyone, but only an operator
            // in draft can act on it — reprice closes the moment the
            // operation is finalized. Without this, the only route back
            // (Unlock) is the quietest control on the page and says nothing
            // about what it's for. `locked` is excluded: the frozen Status
            // token in the facts grid already states that case, and Unlock no
            // longer exists once a payment is recorded.
            <Notice tone="info">
              {canUnlock ? (
                <>
                  Some loot is still unpriced, so the total is short — but repricing is
                  closed while the operation is finalized. Unlock, below the roster,
                  reopens it until it is finalized again.
                </>
              ) : (
                <>
                  Some loot is still unpriced, so the total is short — but repricing is
                  closed while the operation is finalized. Only this operation&apos;s
                  creator or an admin can unlock it.
                </>
              )}
            </Notice>
          )}

        {/* The notices above keep their place ahead of this table. They are
            the fast path for "what needs attention" and are readable without
            opening anything; this table is the *fix* — the place an operator can
            see every line they pasted and reprice one. Removing either notice in
            favour of the table would trade a glance for an expand-and-scan. */}
        {pools.map(
          (pool, index) =>
            pool.items.length > 0 && (
              <Disclosure
                key={pool.id}
                summary={`Pool ${index + 1} items (${pool.items.length})`}
                ariaLabel={`Pool ${index + 1} items (${pool.items.length}) — names, prices, and per-item overrides`}
              >
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
                        <th scope="col">
                          <span className="visually-hidden">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {pool.items.map((item) => (
                        <tr key={item.id}>
                          <td>{item.name}</td>
                          <td className="mono nowrap">{item.qty}</td>
                          <td className="mono nowrap num">{fmtIsk(item.unitPrice)}</td>
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
                          <td>
                            {canEdit && (
                              // Named after the row it acts on, like the
                              // shares input below: "save" alone tells a
                              // speech-input or screen-reader operator which
                              // verb, never which of 200 items.
                              <InlineEditField
                                action={setItemPriceAction.bind(
                                  null,
                                  operation.id,
                                  item.id,
                                )}
                                name="unitPrice"
                                serverValue={item.unitPrice}
                                inputProps={{
                                  className: "field field--money",
                                  type: "number",
                                  inputMode: "decimal",
                                  min: "0",
                                  step: "0.01",
                                  required: true,
                                  "aria-label": `Unit price for ${item.name}`,
                                }}
                                submitAriaLabel={`save unit price for ${item.name}`}
                              />
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Scroller>
              </Disclosure>
            ),
        )}

        {/* "Roster" names the list; "participant" names a single row in it —
            the Scroller label and column headers below follow that rule, so
            it doesn't drift back to "Participants" naming the list too. */}
        <RuleHead
          as="h2"
          aside={
            // Only once there is a roster worth counting — an operator adding
            // the first participant has nothing to report yet, and "0/0" reads
            // as a stalled payout rather than an empty one.
            owedParticipants.length > 0 && (
              <span className="dim mono">
                {paidParticipants.length}/{owedParticipants.length}
              </span>
            )
          }
        >
          Roster
        </RuleHead>
        {canEdit && (
          // Same rule as the loot disclosure above: collapsed only once there
          // is a roster already worth burying, and the paste sits above the
          // table it fills rather than below it — this used to be the other
          // way around (open only when empty), which put the input for the
          // common case ("paste people") beneath the very table it was
          // about to populate.
          <Disclosure
            summary="Edit roster"
            ariaLabel="Edit roster — replace the roster from a paste, or add one participant"
            defaultOpen={participants.length === 0}
          >
            <div className="form-stack">
              <form
                action={setRosterAction.bind(null, operation.id)}
                className="form-stack"
              >
                <RuleHead as="h3">Replace the roster from a paste</RuleHead>
                <label className="form-stack__field">
                  Paste (names separated by /)
                  <textarea className="field" name="paste" rows={8} required />
                </label>
                <Submit className="btn btn--primary">Set roster</Submit>
              </form>

              {/* A plain `<datalist>`, not a type-ahead: the browser does the
                  filtering, so there is no endpoint and no new authorization
                  surface. It lives inside `AddParticipantForm` now — that
                  component's own docblock says why the round-trip fix below
                  needed a client component where this datalist alone did not.
                  The list is omitted entirely past `CHARACTER_NAME_CAP`, and
                  the field then behaves as ordinary free text —
                  `addParticipant` resolves the typed name server-side either
                  way, so a missing suggestion costs a suggestion, not the
                  feature. */}
              <AddParticipantForm
                operationId={operation.id}
                characterNames={characterNames}
              />
            </div>
          </Disclosure>
        )}
        {duplicateUnresolvedNames.length > 0 && (
          <Notice tone="warn">
            <span>
              <strong>
                {duplicateUnresolvedNames.length} unresolved name
                {duplicateUnresolvedNames.length === 1 ? "" : "s"} appear
                {duplicateUnresolvedNames.length === 1 ? "s" : ""} more than once
              </strong>{" "}
              — each is drawing a full share as a separate person. If they are the same
              pilot, remove one before finalizing.
              <br />
              <span className="dim">{duplicateUnresolvedNames.join(", ")}</span>
            </span>
          </Notice>
        )}
        {/* `tone="info"`, not `warn`: roster-warnings.ts documents this as the
            ordinary case — a roster is pasted (unlinked) before the account
            it names gets its ESI link, and the two rows sit side by side
            until someone notices. Genuinely actionable (each row still draws
            a full share), so it stays a notice; not an alarm, because nothing
            here is usually wrong. */}
        {crossStateClashes.length > 0 && (
          <Notice tone="info">
            <span>
              <strong>
                {crossStateClashes.length} name{crossStateClashes.length === 1 ? "" : "s"}{" "}
                on this roster {crossStateClashes.length === 1 ? "is" : "are"} both linked
                and unlinked
              </strong>{" "}
              — one row is tied to an account, another under the same name is not, and
              each is drawing a full share. They may be the same pilot whose link landed
              after the roster was written, or two different people who share a name.
              Check before finalizing.
              <br />
              <span className="dim">{crossStateClashes.join(", ")}</span>
            </span>
          </Notice>
        )}

        {/* `tall` + the dense/sticky-head/sticky-col kit, same as the two admin
            tables (admin/accounts, admin/audit) — but only past
            ROSTER_TALL_THRESHOLD. Unconditional `tall` was tuned for those
            tables' ~50 rows; a dozen-name roster inside the same fixed cap
            clipped a row mid-height on a page with plenty of room left below
            it. Below the threshold the table renders at its natural height,
            same as the loot pools table above it. */}
        <Scroller label="Roster" tall={participants.length > ROSTER_TALL_THRESHOLD}>
          <table className="log log--dense log--sticky-head log--sticky-col">
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
            {/* One scope for the whole roster, so arming "remove" on one row
                disarms whatever was armed on another — a half-armed control two
                rows up is exactly the thing a confirm step is meant to prevent. */}
            <ConfirmArmScope>
              <tbody>
                {participants.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {p.displayName}
                      {p.sourceCharacters.length > 1 && (
                        <span className="dim"> ({p.sourceCharacters.join(", ")})</span>
                      )}
                    </td>
                    <td className="num">
                      {canEdit ? (
                        <InlineEditField
                          action={setParticipantSharesAction.bind(
                            null,
                            operation.id,
                            p.id,
                          )}
                          name="shares"
                          serverValue={p.shares}
                          inputProps={{
                            className: "field field--micro",
                            type: "number",
                            inputMode: "decimal",
                            min: "0.01",
                            step: "0.01",
                            required: true,
                            "aria-label": `Shares for ${p.displayName}`,
                          }}
                          submitAriaLabel={`save ${p.displayName} shares`}
                        />
                      ) : (
                        <span className="mono">{p.shares}</span>
                      )}
                    </td>
                    <td className="mono nowrap num">
                      <div className="stack">
                        <span>{fmtIsk(p.amount)} ISK</span>
                        {/* Copy sits under the amount it copies, not two
                            columns away in Actions — the raw, unformatted
                            p.amount goes to the clipboard, never through
                            fmtIsk, since it's pasted elsewhere verbatim.

                            Wrapped in its own box because `.stack` is a grid
                            and CopyAmountButton renders two siblings: left
                            loose, the button and its result line would take
                            separate grid rows, and the result line reserves
                            5rem of width even while empty — an empty row under
                            every unpaid participant. They belong on one line
                            here exactly as they did in the button row. */}
                        {operation.status === "finalized" &&
                          p.paymentState !== "excluded" && (
                            <div>
                              <CopyAmountButton
                                amount={p.amount}
                                participantName={p.displayName}
                              />
                            </div>
                          )}
                      </div>
                    </td>
                    <td>
                      <div className="stack">
                        {p.paymentState === "excluded" && (
                          <Status tone="off">excluded</Status>
                        )}
                        {/* Neutral, not warn: a freshly finalized operation
                            opens as every row reading "unpaid", and colour
                            that decreases as the payout gets done is
                            backwards. Same call DESIGN.md makes for cryo on
                            the member's own account page — colour only where
                            someone scans for it, neutral where it's expected. */}
                        {p.paymentState === "unpaid" && <Status>unpaid</Status>}
                        {p.paymentState === "paid" && <Status tone="ok">paid</Status>}
                        {/* Stored since phase 1 and never shown until now — and
                            the actor with it, so the list says who, not just
                            what and when. Renders nothing when there is no
                            history. */}
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
                              {access.canOpenInfo && p.recipientCharacterId !== null && (
                                <form
                                  action={openInfoAction.bind(null, operation.id, p.id)}
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
                                <form
                                  action={markPaidAction.bind(null, operation.id, p.id)}
                                >
                                  {firstPayment ? (
                                    <ConfirmSubmit
                                      className="btn btn--micro"
                                      label="mark paid"
                                      restName={`mark paid ${p.displayName}`}
                                      confirmName={`confirm mark paid ${p.displayName}`}
                                    />
                                  ) : (
                                    <Submit className="btn btn--micro">mark paid</Submit>
                                  )}
                                </form>
                              )}
                              {/* Reverting money is not a one-click action, so
                                  it arms first — the same step `remove` and
                                  `delete` already carry in this table, sharing
                                  the one `ConfirmArmScope` around this tbody. */}
                              {p.paymentState === "paid" && access.isOperator && (
                                <form
                                  action={revertPaymentAction.bind(
                                    null,
                                    operation.id,
                                    p.id,
                                  )}
                                >
                                  <ConfirmSubmit
                                    className="btn btn--quiet btn--micro btn--danger-quiet"
                                    armedClassName="btn btn--micro btn--danger"
                                    label="revert"
                                    restName={`revert payment for ${p.displayName}`}
                                    confirmName={`confirm revert payment for ${p.displayName}`}
                                  />
                                </form>
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
                              <Submit className="btn btn--quiet btn--micro">
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
                              {/* Removing redistributes this pilot's share across
                                everyone else. "exclude" beside it does the same
                                to the split but keeps the row, so it is the
                                reversible one and stays a single click. */}
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
                {participants.length === 0 && (
                  <tr>
                    <td className="log__empty" colSpan={5}>
                      <span className="log__empty-text">No roster set yet.</span>
                    </td>
                  </tr>
                )}
              </tbody>
            </ConfirmArmScope>
          </table>
        </Scroller>

        {/* Finalize/Unlock, moved down from ahead of the pools and roster: it
            used to sit ~600 rendered lines above the shares it freezes, so an
            operator scrolled past every number on the page before reaching
            the button that locks them. It now follows the data it operates
            on instead, which is also `.btn-row--controls`'s own reason to
            exist (globals.css; see admin/sync's re-run row for the same
            shape). */}
        {access.isOperator && (
          <ConfirmArmScope>
            {/* Frozen used to be a permanent `warn` Notice stating this same
                fact, seen by every visitor including a member with nothing to
                act on — the facts grid's Status token now covers that. This
                is the part of the old notice actually worth an operator's
                attention: once a payment exists, Finalize is gone, Unlock is
                gone, and the only remaining lever is per-payment revert. Kept
                as a `.dim` sentence beside the controls it explains, gated on
                `access.isOperator` (this block already is), rather than a
                second alarm about a state the Status token already named. */}
            {locked && (
              <p className="dim">
                A payment has been recorded, so the loot pools, the roster, shares and the
                corp share are fixed permanently. Reverting a payment does not reopen
                editing — it corrects who has been paid, and nothing else. If the wrong
                person was marked paid, revert them and pay the right one; both work while
                frozen.
              </p>
            )}
            <div className="btn-row btn-row--tight btn-row--controls">
              {operation.status === "draft" && (
                <form action={finalizeAction.bind(null, operation.id)}>
                  {/* Finalizing freezes every number on the page. Unlock exists,
                      but only until the first payment — so this is the last
                      cheap moment to notice a wrong share. */}
                  <ConfirmSubmit
                    className="btn btn--primary"
                    label="Finalize"
                    confirmName="confirm finalize"
                  />
                </form>
              )}
              {operation.status === "finalized" && !locked && canUnlock && (
                <form action={unlockAction.bind(null, operation.id)}>
                  {/* Unlock stays one click: it reopens editing, and is undone
                      by finalizing again. */}
                  <Submit className="btn btn--quiet">Unlock</Submit>
                </form>
              )}
            </div>
            {/* Unlock used to carry no copy at all, so the one control that
                reopens a finalized operation's numbers said nothing about
                what it did. Sits under the row rather than inside its
                `btn-row--tight` nowrap, which a sentence this long would
                overflow. */}
            {operation.status === "finalized" && !locked && canUnlock && (
              <p className="dim">
                Unlock reopens the pools, roster and shares to editing, until finalized
                again or until the first payment is recorded.
              </p>
            )}
          </ConfirmArmScope>
        )}

        {/* Admin-only, and deliberately last on the page: everything above is
            the case FOR keeping this operation (the roster, the loot, the
            payment history), so the one control that erases all of it reads
            last, not first. Status plays no part in whether this shows up
            (draft, finalized, locked all render it) because the underlying
            rule doesn't care either: a finalized operation with a fully
            reverted roster is exactly as deletable as a draft nobody ever
            priced. `deleteOperation` is the one gate that matters, and it is
            re-checked there, not assumed from `access.isAdmin` here. */}
        {access.isAdmin && (
          <>
            <RuleHead as="h2">Delete operation</RuleHead>
            <ConfirmArmScope>
              <div className="btn-row">
                <form
                  action={deleteOperationAction.bind(null, operation.id)}
                  data-navigates
                >
                  {/* Both grades are the 36px standalone size (DESIGN.md
                      reserves 28px for the admin tables' in-row controls
                      only) — this is a page-level control, not a table cell,
                      so `btn--quiet` at 28px used to grow to 36px the moment
                      it armed, which moves the button out from under a
                      pointer that is aiming right at it. */}
                  <ConfirmSubmit
                    className="btn btn--danger-quiet"
                    armedClassName="btn btn--danger"
                    label="Delete"
                    // The heading directly above already says "Delete operation",
                    // so spelling it again on the button two lines down is a
                    // stutter, not a clarification. `restName` is how the Discord
                    // unlink solves the same split: the visible word shortens, the
                    // spoken name stays whole, and WCAG 2.5.3 holds because the
                    // name still contains the label.
                    restName="Delete operation"
                    confirmName="confirm delete operation"
                    describedBy="delete-operation-cost"
                  />
                </form>
              </div>
              {/* Carried by aria-describedby rather than folded into the
                  button's own name, same call account/page.tsx's Discord
                  unlink makes: a name is spoken ahead of every press and has
                  to stay short, and this sits after the control in reading
                  order. States the real counts about to be destroyed, not a
                  generic warning — an admin deciding whether to press this
                  needs to know whether it is one empty draft or a twelve-name
                  roster with loot recorded against it.

                  `ConfirmCost`, not a plain `<p>`: it reveals only once the
                  button is armed, same as account/page.tsx's Discord unlink
                  cost sentence. That component's own docblock warns the
                  reveal must not widen anything the armed button sits inside
                  — here it is a block below a `btn-row`, not a table `<td>`,
                  so the reveal cannot push the button out from under the
                  pointer that just armed it. */}
              <ConfirmCost id="delete-operation-cost" className="dim">
                Permanently deletes this operation: {participants.length} roster row
                {participants.length === 1 ? "" : "s"} and {fmtIsk(totalValue)} ISK of
                recorded loot. Blocked only if a participant is currently marked paid;
                revert every payment first if so.
              </ConfirmCost>
            </ConfirmArmScope>
          </>
        )}
      </main>
    </>
  );
}
