import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { listPayoutOperations } from "@/services/payout-view";
import { RuleHead, Scroller, SiteHeader, Status } from "@/app/_components/ui";
import { requirePayoutReader } from "./access";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Payouts",
};

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default async function PayoutsPage() {
  const access = await requirePayoutReader();
  if (!access) redirect("/account");
  const ops = await listPayoutOperations(getDb());

  const nav = [
    { key: "account", href: "/account", label: "Account" },
    { key: "payouts", href: "/payouts", label: "Payouts" },
    ...(access.isAdmin
      ? [{ key: "admin", href: "/admin/accounts", label: "Admin" }]
      : []),
  ];

  return (
    <>
      <SiteHeader items={nav} current="payouts" />
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

        <RuleHead as="h2">
          {ops.length === 1 ? "1 operation" : `${ops.length} operations`}
        </RuleHead>
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
                    No operations recorded yet.
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
