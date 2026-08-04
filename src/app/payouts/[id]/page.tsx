import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getDb } from "@/db";
import { getPayoutOperationDetail } from "@/services/payout-view";
import { RuleHead, Scroller, SiteHeader, Status } from "@/app/_components/ui";
import { Submit } from "@/app/_components/submit";
import { requirePayoutReader } from "../access";
import {
  addAppraisedPoolAction,
  addFlatPoolAction,
  deletePoolAction,
  finalizeAction,
  markPaidAction,
  removeParticipantAction,
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

const ERRORS: Record<string, string> = {
  appraisal_failed:
    "Could not price that paste right now (triff.tools did not answer). Nothing was saved — adjust and try again, or use a flat pool.",
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

  return (
    <>
      <SiteHeader items={nav} current="payouts" />
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

        {error && ERRORS[error] && (
          <p className="notice notice--bad" data-glyph="!" role="alert">
            {ERRORS[error]}
          </p>
        )}

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
          <div className="btn-row btn-row--tight">
            {operation.status === "draft" && (
              <form action={finalizeAction.bind(null, operation.id)}>
                <Submit className="btn btn--primary">Finalize</Submit>
              </form>
            )}
            {operation.status === "finalized" && !locked && canUnlock && (
              <form action={unlockAction.bind(null, operation.id)}>
                <Submit className="btn btn--quiet">Unlock</Submit>
              </form>
            )}
          </div>
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
                        <form action={deletePoolAction.bind(null, operation.id, pool.id)}>
                          <Submit className="btn btn--quiet btn--micro btn--danger-quiet">
                            delete
                          </Submit>
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
              <label className="stack">
                Station ID (e.g. Jita 4-4: 60003760)
                <input className="field" name="stationId" defaultValue="60003760" />
              </label>
              <label className="stack">
                Region ID (leave blank if using a station)
                <input className="field" name="regionId" />
              </label>
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
                        action={setParticipantSharesAction.bind(null, operation.id, p.id)}
                        className="inline-form"
                      >
                        <input
                          className="field"
                          name="shares"
                          defaultValue={p.shares}
                          aria-label={`Shares for ${p.displayName}`}
                        />
                        <Submit className="btn btn--micro">save</Submit>
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
                                <Submit className="btn btn--micro">mark paid</Submit>
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
                            <Submit className="btn btn--quiet btn--micro btn--danger-quiet">
                              remove
                            </Submit>
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
          </table>
        </Scroller>
      </main>
    </>
  );
}
