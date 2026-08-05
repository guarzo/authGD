import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import {
  decodePayoutCursor,
  encodePayoutCursor,
  listPayoutOperations,
} from "@/services/payout-view";
import { RuleHead, Scroller, SiteHeader, Status } from "@/app/_components/ui";
import { fmtIsk } from "@/app/_components/format-isk";
import { PendingLink } from "./pending-link";
import { requirePayoutReader } from "./access";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Payouts",
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

export default async function PayoutsPage({
  searchParams,
}: {
  searchParams: Promise<{ before?: string | string[] }>;
}) {
  const access = await requirePayoutReader();
  if (!access) redirect("/account");
  const raw = await searchParams;
  // A hand-edited or stale cursor decodes to undefined and renders page 1,
  // rather than reaching Postgres as an invalid uuid comparison.
  const cursor = decodePayoutCursor(one(raw.before));
  const { operations: ops, nextCursor } = await listPayoutOperations(getDb(), {
    before: cursor,
  });

  const nav = [
    { href: "/account", label: "Your account" },
    { href: "/payouts", label: "Payouts" },
    ...(access.isAdmin ? [{ href: "/admin/accounts", label: "Members" }] : []),
  ];

  // `ops.length` is a PAGE count, not a total. It is called a total only when
  // this page provably IS the whole list — nothing paged into it, nothing left
  // after it. Anywhere else it is labelled `shown`, because "50 operations"
  // reads as a total the moment a 51st exists. Neither branch costs a
  // COUNT(*): both are the length of the rows already in hand.
  const complete = cursor === undefined && nextCursor === null;
  const quantity =
    ops.length === 0
      ? undefined
      : complete
        ? `${ops.length} total`
        : `${ops.length} shown`;

  // A cursor past the end is not an empty list, and without this the reader
  // lands on "No operations recorded yet" with no way back — the exit-link
  // lesson from src/app/admin/audit/page.tsx:286-294.
  const pastEnd = cursor !== undefined && ops.length === 0;

  return (
    <>
      <SiteHeader items={nav} current="/payouts" />
      <main id="main" tabIndex={-1} className="page">
        <div className="page__head">
          <h1>Payouts</h1>
          <p className="page__lede">
            Every fight operation authGD has recorded: what it was worth, who was in it,
            and who has been paid. Your own share of each one is on{" "}
            <Link href="/account">your account</Link>.
          </p>
        </div>

        {/* Any member reads every operation (transparency is the cheapest
            reconciliation mechanism the design has); only an operator — member
            AND active — gets the control that starts a new one. A cryo member
            sees the list with no button here, and the action rejects
            regardless if they reach it another way. */}
        {access.isOperator && (
          <p className="btn-row pager">
            <PendingLink className="btn btn--primary" href="/payouts/new">
              New operation
            </PendingLink>
          </p>
        )}

        <RuleHead
          as="h2"
          aside={quantity && <span className="dim mono">{quantity}</span>}
        >
          Operations
        </RuleHead>
        <Scroller label="Operations">
          <table className="log">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Date</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">
                  Total
                </th>
                <th scope="col">Paid</th>
              </tr>
            </thead>
            <tbody>
              {ops.map((op) => (
                <tr key={op.id}>
                  <td>
                    <PendingLink href={`/payouts/${op.id}`}>{op.name}</PendingLink>
                  </td>
                  <td className="mono nowrap">{fmtDate(op.occurredAt)}</td>
                  <td>
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
                    {op.participantCount === 0 ? (
                      <span className="dim mono">
                        <span aria-hidden="true">&mdash;</span>
                        <span className="visually-hidden">no roster yet</span>
                      </span>
                    ) : op.paidCount === op.participantCount ? (
                      <Status tone="ok">
                        {op.paidCount}/{op.participantCount} paid
                      </Status>
                    ) : (
                      <Status tone="warn">
                        {op.paidCount}/{op.participantCount} paid
                      </Status>
                    )}
                  </td>
                </tr>
              ))}
              {ops.length === 0 && (
                <tr>
                  <td className="log__empty" colSpan={5}>
                    {pastEnd ? (
                      <span className="log__empty-text">
                        Nothing older than this point.{" "}
                        <Link href="/payouts">Back to the latest operations</Link>
                      </span>
                    ) : (
                      <span className="log__empty-text">No operations recorded yet.</span>
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

            The cursor is the only param this URL carries today. If a filter is
            ever added to this list, it must DROP `before` the way
            src/app/admin/audit/page.tsx:33-38 does: a cursor taken from a wider
            query pages into the middle of the narrower one. */}
        {(cursor !== undefined || nextCursor) && (
          <div className="btn-row pager">
            {cursor !== undefined && (
              // A plain anchor, and the lint rule is silenced rather than
              // obeyed — the same call `payouts/[id]/not-found.tsx` makes. Its
              // partner control two lines down is an `<a>` the rule cannot see
              // (its href is a template literal), and a pager whose two halves
              // navigate differently is worse than one that navigates the old
              // way twice.
              // eslint-disable-next-line @next/next/no-html-link-for-pages -- pairs with the `Older` control below, which the rule does not flag.
              <a className="btn" href="/payouts">
                <span aria-hidden="true">←</span> Latest
              </a>
            )}
            {nextCursor && (
              <a
                className="btn"
                href={`/payouts?before=${encodeURIComponent(encodePayoutCursor(nextCursor))}`}
              >
                Older <span aria-hidden="true">→</span>
              </a>
            )}
          </div>
        )}
      </main>
    </>
  );
}
