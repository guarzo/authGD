import { Disclosure } from "@/app/_components/disclosure";
import { fmtIsk } from "@/app/_components/format-isk";
import type { PayoutPaymentView } from "@/services/payout-view";

/** Payment events are audit-grade, so they get a full instant rather than a
 *  relative time — the same shape the audit log uses. */
function fmtAt(d: Date): string {
  return `${d.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

/** Just the clock part, for rows whose calendar day is stated once above them. */
function fmtTime(d: Date): string {
  return `${d.toISOString().slice(11, 19)} UTC`;
}

/**
 * What every event in this history agrees on, so the rows do not have to keep
 * saying it. `crewNorms`' shape from `account/page.tsx`, and the same argument:
 * a real payout gets paid out in one sitting, by one operator, so six rows read
 *
 *   2026-08-10 11:57:07 UTC paid 288,600,000.00 ISK by Fleet Commander
 *
 * six times with only the seconds and the amount differing — and those are the
 * two things an operator is actually scanning for. The repeated words are not
 * merely redundant, they are the majority of each line, and they push the
 * varying part off to where it has to be found by reading.
 *
 * A field is a norm only when every event agrees; one reverted row among five
 * paid ones puts `kind` back on every row rather than dropping it from four.
 * Null means "varies", which is the same thing the rows already handle.
 *
 * Both channels lose exactly the same words on exactly the same rows — the
 * shared line renders in the flow, not in a `visually-hidden`, and the rows
 * hide nothing from either. That is what R4 asks for; a per-row assistive-only
 * restoration would put the fact in one channel and not the other, which is the
 * breach R4 exists to name.
 */
type PaymentNorms = { day: string | null; kind: string | null; actor: string | null };

function paymentNorms(payments: PayoutPaymentView[]): PaymentNorms {
  const uniform = (pick: (p: PayoutPaymentView) => string): string | null => {
    const first = pick(payments[0]);
    return payments.every((p) => pick(p) === first) ? first : null;
  };
  return {
    day: uniform((p) => p.at.toISOString().slice(0, 10)),
    kind: uniform((p) => p.kind),
    actor: uniform((p) => p.actorName ?? "unknown"),
  };
}

/** The norms as one sentence, or null when nothing is shared and every row is
 *  already carrying its own. */
function normsSentence(count: number, norms: PaymentNorms): string | null {
  const { day, kind, actor } = norms;
  if (day === null && kind === null && actor === null) return null;
  const head = kind === null ? `All ${count} events` : `All ${count} ${kind}`;
  const by = actor === null ? "" : ` by ${actor}`;
  const on = day === null ? "" : ` on ${day}`;
  return `${head}${by}${on}.`;
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
  // Owner walkthrough 2026-08-07, finding 1.6: a `Disclosure` collapsed behind
  // "payments (1)" makes the operator open a drawer to read the one line it
  // would have shown anyway — a fold with nothing folded. `payments (3)`
  // asserted at e2e/payouts.spec.ts:1572 still holds: two or more payments is
  // still a history worth collapsing, so the drawer stays there and only the
  // single-payment case renders inline.
  //
  // That single row is also the one with nowhere to hoist a shared fact to, so
  // it keeps the full instant, the kind and the actor. Norms need a set to be
  // norms of.
  const single = payments.length === 1;
  const norms: PaymentNorms = single
    ? { day: null, kind: null, actor: null }
    : paymentNorms(payments);
  const shared = single ? null : normsSentence(payments.length, norms);
  // `.stack` is a grid, which blockifies the items so no markers render.
  const list = (
    <ul className="stack">
      {payments.map((ev) => (
        <li key={ev.id}>
          <span className="mono nowrap">
            {norms.day === null ? fmtAt(ev.at) : fmtTime(ev.at)}
          </span>{" "}
          {norms.kind === null ? `${ev.kind} ` : null}
          <span className="mono nowrap">{fmtIsk(ev.amount)} ISK</span>
          {norms.actor === null ? ` by ${ev.actorName ?? "unknown"}` : null}
        </li>
      ))}
    </ul>
  );
  if (single) return list;
  const body = (
    <>
      {shared === null ? null : <p className="lede">{shared}</p>}
      {list}
    </>
  );
  return (
    <Disclosure
      summary={`payments (${payments.length})`}
      ariaLabel={`payments (${payments.length}) for ${participantName}`}
    >
      {body}
    </Disclosure>
  );
}
