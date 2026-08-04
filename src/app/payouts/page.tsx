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

  // `ops.length` is a PAGE count, not a total. It is shown only when this page
  // provably IS the whole list — nothing paged into it, nothing left after it.
  // Anywhere else "50 operations" would read as a total the moment a 51st
  // exists, and the pager below is what tells the reader there is more.
  const complete = cursor === undefined && nextCursor === null;
  const heading = complete
    ? ops.length === 1
      ? "1 operation"
      : `${ops.length} operations`
    : "Operations";

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
            and who has been paid.
          </p>
        </div>

        {/* Any flygd member reads every operation (transparency is the cheapest
            reconciliation mechanism the design has); only an operator — flygd
            AND active — gets the control that starts a new one. A cryo flygd
            member sees the list with no button here, and the action rejects
            regardless if they reach it another way. */}
        {access.isOperator && (
          <p className="btn-row pager">
            <Link className="btn btn--primary" href="/payouts/new">
              New operation
            </Link>
          </p>
        )}

        <RuleHead as="h2">{heading}</RuleHead>
        <Scroller label="Operations">
          <table className="log">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Date</th>
                <th scope="col">Status</th>
                <th scope="col">Total</th>
                <th scope="col">Paid</th>
              </tr>
            </thead>
            <tbody>
              {ops.map((op) => (
                <tr key={op.id}>
                  <td>
                    <Link href={`/payouts/${op.id}`}>{op.name}</Link>
                  </td>
                  <td className="mono nowrap">{fmtDate(op.occurredAt)}</td>
                  <td>
                    {op.status === "finalized" ? (
                      <Status tone="ok">finalized</Status>
                    ) : (
                      <Status tone="off">draft</Status>
                    )}
                  </td>
                  <td className="mono nowrap">{op.totalValue} ISK</td>
                  <td className="mono nowrap">
                    {op.paidCount}/{op.participantCount}
                  </td>
                </tr>
              ))}
              {ops.length === 0 && (
                <tr>
                  <td className="log__empty" colSpan={5}>
                    {pastEnd ? (
                      <>
                        Nothing older than this point.{" "}
                        <a href="/payouts">Back to the latest operations</a>
                      </>
                    ) : (
                      "No operations recorded yet."
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Scroller>

        {/* The cursor is the only param this URL carries today. If a filter is
            ever added to this list, it must DROP `before` the way
            src/app/admin/audit/page.tsx:33-38 does: a cursor taken from a wider
            query pages into the middle of the narrower one. */}
        {nextCursor && (
          <div className="btn-row pager">
            <a
              className="btn"
              href={`/payouts?before=${encodeURIComponent(encodePayoutCursor(nextCursor))}`}
            >
              Older <span aria-hidden="true">→</span>
            </a>
          </div>
        )}
      </main>
    </>
  );
}
