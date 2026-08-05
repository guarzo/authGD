import { Disclosure } from "@/app/_components/disclosure";
import { fmtIsk } from "@/app/_components/format-isk";
import type { PayoutPaymentView } from "@/services/payout-view";

/** Payment events are audit-grade, so they get a full instant rather than a
 *  relative time — the same shape the audit log uses. */
function fmtAt(d: Date): string {
  return `${d.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

/**
 * One participant's payment history: who did what, and when.
 *
 * A plain component taking already-read rows, split out of the detail page for
 * the same reason AccountPayouts is split out of the account page: both pages
 * are async server components that read the session cookie and the database,
 * so neither can be rendered in a unit test, and the actor rule below is worth
 * pinning directly rather than only end-to-end.
 *
 * `actorName` is null in two cases this cannot tell apart: `payout_payment.actor`
 * is `on delete set null`, so a deleted account leaves the row behind with
 * nobody to name, and an account that never set a main character has no name to
 * resolve to. "unknown" is the honest word for both, and it is deliberately not
 * "system": no job writes a payment row — every one of them is an operator
 * pressing a button — so naming a machine here would be a lie.
 */
export function PaymentHistory({
  payments,
  participantName,
}: {
  payments: PayoutPaymentView[];
  participantName: string;
}) {
  if (payments.length === 0) return null;
  return (
    <Disclosure
      summary={`payments (${payments.length})`}
      ariaLabel={`payments (${payments.length}) for ${participantName}`}
    >
      {/* `.stack` is a grid, which blockifies the items so no markers render. */}
      <ul className="stack">
        {payments.map((ev) => (
          <li key={ev.id}>
            <span className="mono nowrap">{fmtAt(ev.at)}</span> {ev.kind}{" "}
            <span className="mono nowrap">{fmtIsk(ev.amount)} ISK</span> by{" "}
            {ev.actorName ?? "unknown"}
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}
