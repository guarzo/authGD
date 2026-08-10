import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import {
  decodePayoutCursor,
  encodePayoutCursor,
  listPayoutOperations,
} from "@/services/payout-view";
import { navFor } from "@/app/_components/nav-items";
import { RuleHead, Scroller, SiteHeader, Status } from "@/app/_components/ui";
import { Submit } from "@/app/_components/submit";
import { brandProps } from "@/app/_components/brand-server";
import { fmtIsk } from "@/app/_components/format-isk";
import { PendingLink } from "./pending-link";
import { requirePayoutReader } from "./access";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Operations",
};

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Collapses a possibly-repeated query param to one value, last wins — the
 *  same helper the audit page uses, for the same reason: a repeated param
 *  reaching code that declared only `string` took that page down with a 500. */
function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[v.length - 1] : v;
}

/** Reads the status filter, discarding anything that isn't one of the two
 *  values the column itself renders — a hand-edited `?status=whatever` reads
 *  as "no filter" rather than reaching Postgres. Trimmed for the same reason
 *  `q` is: a copied link carrying `?status=draft%20` would otherwise fail both
 *  comparisons and silently render the ENTIRE log, labelled "N total", to a
 *  reader who asked for drafts. */
function statusParam(
  v: string | string[] | undefined,
): "draft" | "finalized" | undefined {
  const s = one(v)?.trim();
  return s === "draft" || s === "finalized" ? s : undefined;
}

/** The active `q`/`status` filters, `before` always absent — the pattern
 *  `admin/audit/page.tsx`'s `filterHrefBase` uses for the same reason: a
 *  cursor taken from a wider (or differently filtered) query pages into the
 *  middle of this one.
 *
 *  The single source for both consumers below (`filterHrefBase` and the
 *  pager's `olderParams`), so the serialization exists once. Two independent
 *  copies is exactly the drift this is meant to prevent. */
function filterParams(params: { q?: string; status?: string }): URLSearchParams {
  const q = new URLSearchParams();
  if (params.q) q.set("q", params.q);
  if (params.status) q.set("status", params.status);
  return q;
}

/** `filterParams` as an href. Used by the `Latest` link, which carries the
 *  filter forward and drops only the cursor, and by the empty-state exit
 *  links, which must not carry a `before` at all. */
function filterHrefBase(params: { q?: string; status?: string }): string {
  const q = filterParams(params).toString();
  return q ? `/payouts?${q}` : "/payouts";
}

export default async function PayoutsPage({
  searchParams,
}: {
  searchParams: Promise<{
    before?: string | string[];
    q?: string | string[];
    status?: string | string[];
  }>;
}) {
  const access = await requirePayoutReader();
  if (!access) redirect("/account");
  const raw = await searchParams;
  // Trimmed the same way the audit page trims actor/target: typed or pasted
  // by hand, and a trailing space would otherwise fall through to "no match"
  // rather than matching. Whitespace-only collapses to "no filter".
  const params = {
    q: one(raw.q)?.trim() || undefined,
    status: statusParam(raw.status),
  };
  const filtered = Boolean(params.q || params.status);
  // A hand-edited or stale cursor decodes to undefined and renders page 1,
  // rather than reaching Postgres as an invalid uuid comparison.
  const cursor = decodePayoutCursor(one(raw.before));
  const { operations: ops, nextCursor } = await listPayoutOperations(getDb(), {
    before: cursor,
    viewerAccountId: access.accountId,
    q: params.q,
    status: params.status,
  });

  // `canReadPayouts: true` is proven by `requirePayoutReader()` above having
  // returned non-null rather than redirecting.
  const nav = navFor({ canReadPayouts: true, isAdmin: access.isAdmin });

  // `ops.length` is a PAGE count, not a total. It is called a total only when
  // this page provably IS the whole list — nothing paged into it, nothing left
  // after it. Anywhere else it is labelled `shown`, because "50 operations"
  // reads as a total the moment a 51st exists. Neither branch costs a
  // COUNT(*): both are the length of the rows already in hand.
  //
  // `filtered` also forces `shown`, even on a one-page filtered result: what
  // this page can prove complete is the FILTERED set, not the corpus, and
  // "12 total" reads as "12 operations exist", not "12 match this search".
  const complete = !filtered && cursor === undefined && nextCursor === null;
  const quantity =
    ops.length === 0
      ? undefined
      : complete
        ? `${ops.length} total`
        : `${ops.length} shown`;

  // A cursor past the end is not an empty list, and without this the reader
  // lands on "No operations recorded yet" with no way back — the exit-link
  // lesson from the audit log's own past-end branch ("Back to the latest
  // entries", admin/audit/page.tsx). Named rather than cited by line: the
  // number this comment used to carry had already drifted onto an unrelated
  // query call.
  const pastEnd = cursor !== undefined && ops.length === 0;
  // A filter that matches nothing is a THIRD empty case, distinct from both of
  // the above: reading it as "no operations recorded yet" tells an operator
  // their data is gone. `pastEnd` takes priority when both are somehow true
  // (a stale cursor plus a filter), since its exit link is the more specific one.
  const noMatches = !pastEnd && filtered && ops.length === 0;
  const hrefBase = filterHrefBase(params);

  // The pager's own params: the same filter serialization every other link
  // uses, plus `before` on the Older link only — `Latest` reuses `hrefBase`
  // unchanged, so it carries the filter forward and drops only the cursor.
  const olderParams = filterParams(params);
  if (nextCursor) olderParams.set("before", encodePayoutCursor(nextCursor));

  return (
    <>
      <SiteHeader items={nav} current="/payouts" {...brandProps()} />
      <main id="main" tabIndex={-1} className="page">
        <div className="page__head">
          {/* Any member reads every operation (transparency is the cheapest
              reconciliation mechanism the design has); only an operator —
              member AND active — gets the control that starts a new one. A
              cryo member sees the list with no button here, and the action
              rejects regardless if they reach it another way. It sits beside
              the H1 rather than in its own row below the lede, so it reads at
              a glance as the one gold thing on this view. */}
          <div className="page__head-row">
            <h1>Operations</h1>
            {access.isOperator && (
              <PendingLink className="btn btn--primary" href="/payouts/new">
                New operation
              </PendingLink>
            )}
          </div>
          <p className="page__lede">
            Your own share of each operation is on{" "}
            <Link href="/account">your account</Link>.
          </p>
        </div>

        <RuleHead as="h2">Filter</RuleHead>
        {/* GET, no hidden `before` field — a fresh filter submit therefore
            never carries the previous query's cursor forward, which is the
            correctness rule pre-written below the pager: a cursor taken from
            a wider (or differently filtered) query pages into the middle of
            this one. Matches `admin/audit/page.tsx`'s filter-form markup and
            labelling rather than inventing a second idiom. */}
        <form method="get" className="filter-form">
          <div className="filter-form__cell">
            <label className="filter-form__label" htmlFor="filter-q">
              Name
            </label>
            {/* No hint. `admin/audit`'s three fields each carry one because
                Actor, Action and Target are three ways of narrowing the same
                row and the label alone doesn't say which is which. Here the
                label is the whole answer — a field called Name under a table
                whose first column is Name — so a hint restates it, and the
                one cell carrying it made the row read as two rows deep on the
                left and one on the right. */}
            <input
              id="filter-q"
              className="field"
              name="q"
              defaultValue={params.q ?? ""}
            />
          </div>
          <div className="filter-form__cell">
            <label className="filter-form__label" htmlFor="filter-status">
              Status
            </label>
            <select
              id="filter-status"
              className="field"
              name="status"
              defaultValue={params.status ?? ""}
            >
              <option value="">any</option>
              <option value="draft">draft</option>
              <option value="finalized">finalized</option>
            </select>
          </div>
          <div className="filter-form__cell filter-form__cell--actions">
            <div className="filter-form__actions">
              {/* Filter is routine and reversible, not the page's primary act
                  — gold (btn--primary) is rationed for New operation. */}
              <Submit className="btn">Filter</Submit>
              {filtered && (
                <Link className="btn btn--quiet" href="/payouts">
                  clear
                </Link>
              )}
            </div>
          </div>
        </form>

        <RuleHead
          as="h2"
          aside={quantity && <span className="dim mono">{quantity}</span>}
        >
          Log
        </RuleHead>
        <Scroller label="Operations log">
          {/* `log--sticky-col` pins Name. Six columns do not fit a 320px
              viewport by any arrangement (the budget is measured out in
              globals.css beside `.log--payouts`), so this table scrolls — and
              a row whose identity scrolls away is a ledger you cannot read a
              figure off. The mechanism is entirely the shared class: the
              opaque ground, the edge hairline, the corner cell and the
              flattened hover all come from `.log--sticky-col` in globals.css,
              and the Scroller's start fade steps aside for it on its own via
              `:has()`. */}
          <table className="log log--payouts log--sticky-col">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Date</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">
                  Total
                </th>
                <th scope="col">Paid</th>
                <th scope="col">Yours</th>
              </tr>
            </thead>
            <tbody>
              {ops.map((op) => (
                <tr key={op.id}>
                  {/* Each cell leads with a `.payouts__label`, hidden above
                      30rem where the real `<thead>` is naming the columns and
                      shown below it where the row has reflowed to blocks and
                      the `<thead>` is gone. Same construction as
                      `.crew__label` on the accounts drawer, and the reasoning
                      — why a real element rather than `content: attr()`, and
                      why the label is in the DOM at every width rather than
                      swapped in — is in that rule's docblock in globals.css.
                      These stay `<td>`, not `<th scope="row">`: `.log th`
                      carries `white-space: nowrap`, which would inherit into
                      the Name cell and defeat the `overflow-wrap: anywhere`
                      that keeps a 60-character operation name from setting the
                      column's width. */}
                  <td>
                    <span className="payouts__label">Name</span>
                    <PendingLink href={`/payouts/${op.id}`}>{op.name}</PendingLink>
                  </td>
                  <td className="mono nowrap">
                    <span className="payouts__label">Date</span>
                    {fmtDate(op.occurredAt)}
                  </td>
                  <td>
                    <span className="payouts__label">Status</span>
                    {op.status === "finalized" ? (
                      <Status tone="ok">finalized</Status>
                    ) : (
                      <Status tone="off">draft</Status>
                    )}
                  </td>
                  {/* A draft created ten seconds ago has no pools and no
                      roster, and rendering that as `0.00 ISK  0/0` states two
                      figures the operator never entered as if they were
                      findings. An em dash is the absence itself. The zero test
                      is gated on `draft` so a finalized operation that really
                      did pay nothing still prints its number — there the zero
                      IS the finding.

                      The dash is `aria-hidden` with the words beside it rather
                      than an `aria-label` on the span: `aria-label` is only
                      honoured on interactive or landmark roles, so on a bare
                      span it is silently dropped and the cell reads as an
                      unexplained punctuation mark. `.visually-hidden` is the
                      pattern `<Tier>` already uses for exactly this. */}
                  <td className="mono nowrap num">
                    <span className="payouts__label">Total</span>
                    {op.status === "draft" && Number(op.totalValue) === 0 ? (
                      <span className="dim">
                        <span aria-hidden="true">&mdash;</span>
                        <span className="visually-hidden">no value recorded yet</span>
                      </span>
                    ) : (
                      `${fmtIsk(op.totalValue)} ISK`
                    )}
                  </td>
                  {/* The same fact `account-payouts.tsx` and `[id]/page.tsx`
                      both render as a Status. A bare fraction in `.mono` asks
                      the reader to do the comparison; the token has already
                      done it, and carries the glyph and the word so the hue is
                      never the only signal. */}
                  <td>
                    <span className="payouts__label">Paid</span>
                    {op.participantCount === 0 ? (
                      <span className="dim mono">
                        <span aria-hidden="true">&mdash;</span>
                        <span className="visually-hidden">no roster yet</span>
                      </span>
                    ) : op.paidCount === op.participantCount ? (
                      <Status tone="ok">
                        {op.paidCount}/{op.participantCount} paid
                      </Status>
                    ) : op.status === "finalized" ? (
                      // A finalized operation with unpaid rows is the one
                      // genuinely stalled case: the roster is locked and
                      // nothing further should change it, so rows still
                      // unpaid past that point are the fault the warn colour
                      // exists for.
                      <Status tone="warn">
                        {op.paidCount}/{op.participantCount} paid
                      </Status>
                    ) : (
                      // A draft mid-payment is the normal state of active
                      // work, not a fault — most rows on a live list are
                      // exactly this, and rendering them amber burned the
                      // alarm colour on nothing. Neutral (--ink-dim, Status's
                      // default tone) matches how the account page already
                      // reads a pause nobody asked to be alarmed about.
                      <Status tone="neutral">
                        {op.paidCount}/{op.participantCount} paid
                      </Status>
                    )}
                  </td>
                  {/* "Was I paid?" — walkthrough finding 2.1. No ISK figure:
                      see the `viewerState` docblock in payout-view.ts for why
                      a draft's amount can't be shown here. `paid`/`unpaid`
                      reuse the neighbouring Paid column's own tone logic
                      (draft-mid-payment is neutral, not amber — the amber
                      grade is reserved for a finalized roster still unpaid).
                      `excluded` (roster explicitly excludes this viewer) reuses
                      the tone the participant table itself uses for the same
                      state. `absent` and `unresolved` both follow the dash
                      idiom above: `aria-hidden` dash plus visually-hidden
                      words, never `aria-label` on a bare span — silently
                      dropped there, same as the Total cell's comment explains.
                      Their hidden text differs because the claim differs, and
                      only one of the two is provable — see `ViewerPayoutState`. */}
                  <td>
                    <span className="payouts__label">Yours</span>
                    {op.viewerState === "paid" && <Status tone="ok">paid</Status>}
                    {op.viewerState === "unpaid" &&
                      (op.status === "finalized" ? (
                        <Status tone="warn">unpaid</Status>
                      ) : (
                        <Status tone="neutral">unpaid</Status>
                      ))}
                    {op.viewerState === "excluded" && (
                      <Status tone="off">excluded</Status>
                    )}
                    {op.viewerState === "absent" && (
                      <span className="dim mono">
                        <span aria-hidden="true">&mdash;</span>
                        <span className="visually-hidden">not on this roster</span>
                      </span>
                    )}
                    {op.viewerState === "unresolved" && (
                      <span className="dim mono">
                        <span aria-hidden="true">&mdash;</span>
                        <span className="visually-hidden">
                          roster has unresolved names
                        </span>
                      </span>
                    )}
                    {/* Unreachable while `PayoutAccess.accountId` is a
                        non-nullable string, so this page always asks for a
                        viewer. Kept because the alternative to a fallthrough
                        is a blank cell under a header that promises an
                        answer — a silent one, with no type error to catch it
                        if the field ever becomes genuinely optional here. */}
                    {op.viewerState === undefined && (
                      <span className="dim mono">
                        <span aria-hidden="true">&mdash;</span>
                        <span className="visually-hidden">not available</span>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {ops.length === 0 && (
                <tr>
                  <td className="log__empty" colSpan={6}>
                    {pastEnd ? (
                      <span className="log__empty-text">
                        Nothing older than this point.{" "}
                        <Link href={hrefBase}>Back to the latest operations</Link>
                      </span>
                    ) : noMatches ? (
                      // Distinct from the two branches below: the log is not
                      // empty and the corp's history isn't gone, this filter
                      // just matched nothing. Reading it as "no operations
                      // recorded yet" would tell an operator their data
                      // disappeared.
                      <span className="log__empty-text">
                        Nothing matches this filter.{" "}
                        <Link href="/payouts">Back to every operation</Link>
                      </span>
                    ) : (
                      <span className="log__empty-text">
                        {access.isOperator
                          ? "No operations recorded yet. Start the first one with New operation, above."
                          : "No operations recorded yet."}
                      </span>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Scroller>

        {/* Paging was one-way: `Older →` appeared and nothing ever offered the
            way back, so the only exit from page 2 was Back or hand-editing the
            URL. `← Latest` is rendered off `cursor`, not off `nextCursor`, so
            it survives the last page — which is exactly the page that had no
            control at all.

            Both links carry the active filter forward via `hrefBase` /
            `olderParams` and only ever add or drop `before` — the correctness
            rule from src/app/admin/audit/page.tsx:33-38: a cursor taken from a
            wider (or differently filtered) query pages into the middle of the
            narrower one. */}
        {(cursor !== undefined || nextCursor) && (
          <div className="btn-row pager">
            {cursor !== undefined && (
              // A plain anchor rather than next/link: `hrefBase` is a computed
              // string (the active filter, `before` dropped), so the lint rule
              // that would otherwise flag a literal `/payouts` href doesn't
              // see this as a hardcoded page link at all. Its partner control
              // two lines down is an `<a>` for the same reason (its href is
              // also a computed string), and a pager whose two halves navigate
              // differently is worse than one that navigates the old way
              // twice.
              <a className="btn" href={hrefBase}>
                <span aria-hidden="true">←</span> Latest
              </a>
            )}
            {nextCursor && (
              <a className="btn" href={`/payouts?${olderParams.toString()}`}>
                Older <span aria-hidden="true">→</span>
              </a>
            )}
          </div>
        )}
      </main>
    </>
  );
}
