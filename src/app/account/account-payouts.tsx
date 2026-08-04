import { RuleHead, Scroller, Status } from "@/app/_components/ui";
import type { AccountPayoutRow } from "@/services/payout-view";

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The member's own finalized payouts.
 *
 * A plain (non-async) component taking already-read rows rather than querying
 * for itself: that is what lets tests/account-payouts.test.ts render it
 * directly, the way tests/account-page.test.ts renders ContactRemedy. The
 * account page is an async server component reading the session cookie and the
 * database, and cannot be rendered outside a request.
 *
 * `linkToOperations` is the viewer's `canReadPayouts` verdict, passed in rather
 * than re-derived. Reading your own history needs only a session; reading an
 * OPERATION needs tier flygd. A member demoted to blue/green, or moved to
 * cryo, still gets the answer to "did I get paid for that Thursday roam"
 * without regaining access to the operation — and always linking would hand
 * them a link that silently redirects back to this page.
 *
 * Plain `<a>` rather than next/link, matching every other link on this page,
 * which also keeps it renderable outside the Next router for that test.
 *
 * One row per operation: alts collapse into one participant, and an unresolved
 * name carries no accountId at all, so nothing here can duplicate an
 * operationId key.
 */
export function AccountPayouts({
  rows,
  linkToOperations,
}: {
  rows: AccountPayoutRow[];
  linkToOperations: boolean;
}) {
  return (
    <>
      <RuleHead as="h2">Your payouts</RuleHead>
      <Scroller label="Your payouts">
        <table className="log">
          <thead>
            <tr>
              <th scope="col">Operation</th>
              <th scope="col">Date</th>
              <th scope="col">Amount owed</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.operationId}>
                <td>
                  {linkToOperations ? (
                    <a href={`/payouts/${r.operationId}`}>{r.operationName}</a>
                  ) : (
                    r.operationName
                  )}
                </td>
                <td className="mono nowrap">{fmtDate(r.occurredAt)}</td>
                {/* The exact numeric(20,2) string the column holds. */}
                <td className="mono nowrap">{r.amount} ISK</td>
                <td>
                  {r.paid ? (
                    <Status tone="ok">paid</Status>
                  ) : (
                    <Status tone="warn">unpaid</Status>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Scroller>
    </>
  );
}
