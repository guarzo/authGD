import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getDb } from "@/db";
import { getPayoutOperationDetail } from "@/services/payout-view";
import { Notice, RuleHead, Scroller, SiteHeader, Status } from "@/app/_components/ui";
import { Submit } from "@/app/_components/submit";
import { ConfirmArmScope, ConfirmSubmit } from "@/app/_components/confirm-submit";
import { requirePayoutReader } from "../access";
import {
  addAppraisedPoolAction,
  addFlatPoolAction,
  deletePoolAction,
  finalizeAction,
  markPaidAction,
  removeParticipantAction,
  setCorpShareAction,
  setParticipantExcludedAction,
  setParticipantSharesAction,
  setRosterAction,
  unlockAction,
} from "../actions";
import { CopyAmountButton } from "./copy-amount-button";
import { PRICING_MODES, type PricingMode } from "@/core/pricing";
import { iskToCents } from "@/core/payout-split";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Payout operation",
};

const PRICING_LABELS: Record<PricingMode, string> = {
  sell_best: "Sell (best)",
  sell_p05: "Sell (5th percentile)",
  buy_best: "Buy (best)",
  buy_p05: "Buy (5th percentile)",
};

/** Every code an action on this page can redirect with. A code with no entry
 *  renders nothing at all, which is the one failure this page cannot show the
 *  operator, so e2e checks each by name.
 *
 *  Several of these are backstops rather than everyday errors: the appraisal
 *  form's pricing mode and location kind are <select>s and its location id is
 *  pattern-guarded, so `pricing_mode`, `location_kind`, `station_invalid` and
 *  `region_invalid` are unreachable by filling the form in. That is deliberate
 *  — a redirect cannot carry the loot paste back, so those failures are
 *  prevented at the input rather than explained after the fact. None of these
 *  messages claims the paste survived, because on those paths it did not. */
const ERRORS: Record<string, string> = {
  appraisal_failed:
    "Could not price that paste right now (triff.tools did not answer). Nothing was saved — adjust and try again, or use a flat pool.",
  pricing_mode: "That is not one of the four pricing modes. Nothing was saved.",
  location_kind:
    "Price against a station or a region — triff accepts exactly one. Nothing was saved.",
  station_invalid:
    "Station ID must be digits only — Jita 4-4 is 60003760. Nothing was saved.",
  region_invalid: "Region ID must be digits only. Nothing was saved.",
  note_required:
    "A flat pool needs a note saying where the number came from. It is the only record of why this total is what it is.",
  total_invalid:
    "Total must be a plain number like 12345.67 — no commas, and no shorthand like 1e5.",
  shares_required: "Shares cannot be blank. The roster value was left as it was.",
  shares_invalid:
    "Shares must be a plain number like 1 or 1.5. The roster value was left as it was.",
  shares_positive:
    "Shares must be greater than zero. To pay someone nothing, exclude them instead — that keeps them on the roster and out of the split.",
  shares_range: "Shares cannot exceed 9999.99. The roster value was left as it was.",
  share_format:
    "Corp share must be a plain percentage like 10 or 12.5. The old value is unchanged.",
  share_range:
    "Corp share cannot exceed 100% — that would leave the roster nothing to split. The old value is unchanged.",
  participant_name_required:
    "Type a character name to add someone to the roster. Nothing was added.",
  participant_duplicate:
    "Someone is already on this roster under that name. Nothing was added — two rows under one unresolved name pay two full shares to whoever answers to it.",
};

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default async function PayoutOperationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const access = await requirePayoutReader();
  if (!access) redirect("/account");
  const { id } = await params;
  const { error } = await searchParams;
  const errorMessage = error ? ERRORS[error] : undefined;
  const detail = await getPayoutOperationDetail(getDb(), id);
  if (!detail) notFound();
  const { operation, pools, participants, totalValue, corpAmount, locked } = detail;

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

  // A name with no accountId is an unresolved roster entry (resolveRosterNames
  // never dedupes those against each other, on purpose — see its own comment).
  // Unreachable today: PR 1's only roster input is setRosterAction, which goes
  // through parseRosterPaste (itself case-insensitively deduped) once per
  // paste, so no single roster can produce two rows with the same name. This
  // stays wired up because PR 2 adds manual participant entry outside that
  // paste path, and the day it lands, two rows sharing a display name are two
  // full shares going out under one name — this is what keeps the FC from
  // finding out only after finalizing.
  const unresolvedByLowerName = new Map<string, string>(); // key -> first-seen spelling
  const unresolvedNameCounts = new Map<string, number>();
  for (const p of participants) {
    if (p.accountId === null) {
      const key = p.displayName.toLowerCase();
      unresolvedByLowerName.set(key, unresolvedByLowerName.get(key) ?? p.displayName);
      unresolvedNameCounts.set(key, (unresolvedNameCounts.get(key) ?? 0) + 1);
    }
  }
  const duplicateUnresolvedNames = [...unresolvedNameCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => unresolvedByLowerName.get(key)!);

  // Only the *first* payment is worth an arm step. Recording one is what shuts
  // the door permanently — `hasPayments` makes the operation un-editable and
  // un-unlockable from then on (Recalculation safety, mechanism 3). Every later
  // "mark paid" is a click behind a door already shut, so gating those would be
  // friction with nothing behind it.
  const anyPaid = participants.some((p) => p.paymentState === "paid");

  return (
    <>
      <SiteHeader items={nav} current="/payouts" />
      <main id="main" tabIndex={-1} className="page">
        <div className="page__head">
          <h1>{operation.name}</h1>
          <p className="page__lede">
            {fmtDate(operation.occurredAt)}
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

        {errorMessage && <Notice tone="bad">{errorMessage}</Notice>}

        <RuleHead as="h2">Operation</RuleHead>
        <dl className="facts">
          <dt>Status</dt>
          <dd>
            {operation.status === "finalized" ? (
              <Status tone="ok">finalized</Status>
            ) : (
              <Status tone="off">draft</Status>
            )}
          </dd>
          <dt>Corp share</dt>
          <dd className="mono">
            {corpAmount} ISK{" "}
            <span className="dim">({operation.corpSharePct}% + remainder)</span>
            {/* The percentage used to be write-once: an operator who accepted
                the create form's default committed the whole roster to 0% with
                no way back short of deleting the operation. It sits inside the
                fact it corrects rather than in a separate edit panel, so the
                current value and the way to change it are the same glance. */}
            {canEdit && (
              <form
                action={setCorpShareAction.bind(null, operation.id)}
                className="inline-form"
              >
                <label className="dim" htmlFor="corp-share">
                  Corp share %
                </label>
                <input
                  id="corp-share"
                  className="field"
                  name="corpSharePct"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  max="100"
                  step="0.01"
                  required
                  defaultValue={operation.corpSharePct}
                />
                {/* Every "save" on this page needs its object spelled out: the
                    word alone appears once here and once per participant row,
                    and a screen-reader or speech-input operator reaching one out
                    of visual context cannot tell them apart. Starts with the
                    visible label, so it stays a WCAG 2.5.3 match. */}
                <Submit className="btn btn--micro" aria-label="save corp share">
                  save
                </Submit>
              </form>
            )}
          </dd>
          <dt>Total loot</dt>
          <dd className="mono">{totalValue} ISK</dd>
          {operation.notes && (
            <>
              <dt>Notes</dt>
              <dd>{operation.notes}</dd>
            </>
          )}
        </dl>

        {access.isOperator && (
          <ConfirmArmScope>
            <div className="btn-row btn-row--tight">
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
          </ConfirmArmScope>
        )}

        <RuleHead as="h2" aside={<span className="dim mono">{totalValue} ISK</span>}>
          Loot pools
        </RuleHead>
        <Scroller label="Loot pools">
          <table className="log">
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Value</th>
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
                {pools.map((pool) => {
                  // An unresolved item priced at 0.00 is the one thing on this page
                  // an operator MUST see before finalizing: it means the total is
                  // quietly low and everyone is about to be underpaid. Naming the
                  // items is the whole safeguard — a count alone doesn't tell you
                  // whether it's a junk module or the faction battleship.
                  const unresolved = pool.items.filter(
                    (i) => i.priceSource === "unresolved",
                  );
                  // A resolved item can still show "0.00" as its unit price: the
                  // line total is rounded once (see appraiseLoot), so a sub-cent
                  // per-unit price stores as a 2dp display value that reads as
                  // free while the line genuinely contributed to the pool. This
                  // is derived from the persisted row, not a separate flag.
                  const subCentPriced = pool.items.filter(
                    (i) =>
                      i.priceSource === "triff" &&
                      iskToCents(i.unitPrice) === 0n &&
                      iskToCents(i.totalValue) !== 0n,
                  );
                  return (
                    <tr key={pool.id}>
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
                      <td className="mono nowrap">{pool.totalValue} ISK</td>
                      <td>
                        {pool.notes}
                        {unresolved.length > 0 && (
                          <p className="notice notice--warn" data-glyph="!">
                            <span>
                              <strong>
                                {unresolved.length} item
                                {unresolved.length === 1 ? "" : "s"} priced at 0.00
                              </strong>{" "}
                              — not found, or no market data for the chosen pricing. The
                              pool total is short by whatever they are worth.
                              <br />
                              <span className="dim">
                                {unresolved.map((i) => `${i.name} ×${i.qty}`).join(", ")}
                              </span>
                            </span>
                          </p>
                        )}
                        {subCentPriced.length > 0 && (
                          <p className="notice notice--warn" data-glyph="!">
                            <span>
                              <strong>
                                {subCentPriced.length} item
                                {subCentPriced.length === 1 ? "" : "s"} priced under 0.01
                                ISK each
                              </strong>{" "}
                              — the unit price rounds to 0.00 for display only; the line
                              total is real and already counted in the pool.
                              <br />
                              <span className="dim">
                                {subCentPriced
                                  .map((i) => `${i.name} ×${i.qty} (${i.totalValue} ISK)`)
                                  .join(", ")}
                              </span>
                            </span>
                          </p>
                        )}
                      </td>
                      <td>
                        {canEdit && (
                          <form
                            action={deletePoolAction.bind(null, operation.id, pool.id)}
                          >
                            {/* Deleting a pool drops its whole appraisal — the
                              paste, every priced line, the lot — and the only
                              way back is to re-paste and re-price. */}
                            <ConfirmSubmit
                              className="btn btn--quiet btn--micro btn--danger-quiet"
                              label="delete"
                              restName="delete pool"
                              confirmName="confirm delete pool"
                            />
                          </form>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {pools.length === 0 && (
                  <tr>
                    <td className="log__empty" colSpan={4}>
                      No loot recorded yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </ConfirmArmScope>
          </table>
        </Scroller>

        {canEdit && (
          <div className="stack">
            <form action={addFlatPoolAction.bind(null, operation.id)} className="stack">
              <RuleHead as="h3">Add a flat-valued pool</RuleHead>
              <label className="stack">
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
              <label className="stack">
                Note (required — why this number)
                <input className="field" name="notes" required />
              </label>
              <label className="stack">
                What was in it (optional)
                <textarea className="field" name="rawPaste" rows={2} />
              </label>
              <Submit className="btn">Add flat pool</Submit>
            </form>

            <form
              action={addAppraisedPoolAction.bind(null, operation.id)}
              className="stack"
            >
              <RuleHead as="h3">Appraise a loot paste</RuleHead>
              <label className="stack">
                Loot paste
                <textarea className="field" name="rawPaste" rows={6} required />
              </label>
              <label className="stack">
                Pricing
                <select className="field" name="pricingMode" defaultValue="sell_best">
                  {PRICING_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {PRICING_LABELS[mode]}
                    </option>
                  ))}
                </select>
              </label>
              {/* Kind + id, rather than a station box and a region box the
                  operator must leave one of blank. triff accepts exactly one,
                  and this is the only form on the page whose failure would cost
                  the operator a long paste, so the rule is expressed as a shape
                  that cannot be filled in wrongly rather than as prose above two
                  inputs that can. */}
              <label className="stack">
                Price at
                <select className="field" name="locationKind" defaultValue="station">
                  <option value="station">Station</option>
                  <option value="region">Region</option>
                </select>
              </label>
              <label className="stack">
                Station or region ID
                <input
                  className="field"
                  name="locationId"
                  inputMode="numeric"
                  pattern="[0-9]+"
                  defaultValue="60003760"
                  required
                  aria-describedby="appraise-location-hint"
                />
              </label>
              <span className="dim" id="appraise-location-hint">
                Digits only. Jita 4-4 is station 60003760; The Forge is region 10000002.
              </span>
              <Submit className="btn" pendingLabel="Pricing…">
                Appraise
              </Submit>
            </form>
          </div>
        )}

        <RuleHead as="h2">Roster</RuleHead>
        {duplicateUnresolvedNames.length > 0 && (
          <p className="notice notice--warn" data-glyph="!" role="alert">
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
          </p>
        )}
        {canEdit && (
          <form action={setRosterAction.bind(null, operation.id)} className="stack">
            <label className="stack">
              Paste (names separated by /)
              <textarea className="field" name="paste" rows={3} required />
            </label>
            <Submit className="btn">Set roster</Submit>
          </form>
        )}

        <Scroller label="Participants">
          <table className="log">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Shares</th>
                <th scope="col">Amount</th>
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
                    <td>
                      {canEdit ? (
                        <form
                          action={setParticipantSharesAction.bind(
                            null,
                            operation.id,
                            p.id,
                          )}
                          className="inline-form"
                        >
                          <input
                            className="field"
                            name="shares"
                            type="number"
                            inputMode="decimal"
                            min="0.01"
                            step="0.01"
                            required
                            defaultValue={p.shares}
                            aria-label={`Shares for ${p.displayName}`}
                          />
                          <Submit
                            className="btn btn--micro"
                            aria-label={`save ${p.displayName} shares`}
                          >
                            save
                          </Submit>
                        </form>
                      ) : (
                        <span className="mono">{p.shares}</span>
                      )}
                    </td>
                    <td className="mono nowrap">{p.amount} ISK</td>
                    <td>
                      {p.paymentState === "excluded" && (
                        <Status tone="off">excluded</Status>
                      )}
                      {p.paymentState === "unpaid" && <Status tone="warn">unpaid</Status>}
                      {p.paymentState === "paid" && <Status tone="ok">paid</Status>}
                    </td>
                    <td>
                      <div className="btn-row btn-row--tight btn-row--end">
                        {operation.status === "finalized" &&
                          p.paymentState !== "excluded" && (
                            <>
                              <CopyAmountButton amount={p.amount} />
                              {p.paymentState !== "paid" && access.isOperator && (
                                <form
                                  action={markPaidAction.bind(null, operation.id, p.id)}
                                >
                                  {anyPaid ? (
                                    <Submit className="btn btn--micro">mark paid</Submit>
                                  ) : (
                                    <ConfirmSubmit
                                      className="btn btn--micro"
                                      label="mark paid"
                                      restName={`mark paid ${p.displayName}`}
                                      confirmName={`confirm mark paid ${p.displayName}`}
                                    />
                                  )}
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
                      No roster set yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </ConfirmArmScope>
          </table>
        </Scroller>
      </main>
    </>
  );
}
