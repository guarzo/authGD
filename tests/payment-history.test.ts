import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PaymentHistory } from "@/app/payouts/[id]/payment-history";
import type { PayoutPaymentView } from "@/services/payout-view";

// Renders the section directly, the way tests/account-page.test.ts renders
// ContactRemedy: the detail page is an async server component that reads the
// session cookie and the database, so it cannot be rendered outside a
// request. What this pins is the rule the design states and the markup could
// silently drop — history is who did what and when, not just what and when.
function payment(over: Partial<PayoutPaymentView> = {}): PayoutPaymentView {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    participantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    kind: "paid",
    amount: "450000.00",
    at: new Date("2026-08-01T12:34:56Z"),
    actor: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    note: null,
    actorName: "FC Prime",
    ...over,
  };
}

const render = (payments: PayoutPaymentView[]) =>
  renderToStaticMarkup(
    createElement(PaymentHistory, { payments, participantName: "Brain Tartare" }),
  );

describe("PaymentHistory", () => {
  it("names the operator who recorded each event, with a full instant", () => {
    const html = render([
      payment(),
      payment({
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        kind: "reverted",
        actorName: "Second FC",
      }),
    ]);
    // Two events, differing in kind and actor, sharing a calendar day. Only the
    // day is a norm, so it is stated once and the rows keep the clock — which
    // is the part that differs between them.
    expect(html).toContain("All 2 events on 2026-08-01.");
    expect(html).toContain("12:34:56 UTC");
    expect(html).not.toContain("2026-08-01 12:34:56 UTC");
    // fmtIsk groups this display value with commas — the raw "450000.00"
    // form no longer appears in the rendered markup.
    expect(html).toContain("450,000.00 ISK");
    expect(html).toContain("reverted");
    expect(html).toContain("FC Prime");
    expect(html).toContain("Second FC");
  });

  // The shape a real payout actually produces: one operator settles the roster
  // in one sitting, so kind, actor and day are all constant and the only thing
  // that varies between rows is the clock and the amount. Those two are what
  // the operator is scanning for, and they were previously buried mid-sentence
  // behind three words the row shared with every other row.
  it("states what every event agrees on once, and drops it from the rows", () => {
    const html = render([
      payment(),
      payment({
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        at: new Date("2026-08-01T12:40:00Z"),
        amount: "900000.00",
      }),
    ]);
    expect(html).toContain("All 2 paid by FC Prime on 2026-08-01.");
    // Said once, in the shared line, and nowhere else. Both channels lose the
    // same words on the same rows — nothing is restored for assistive tech that
    // is not also on screen (R4).
    expect(html.match(/FC Prime/g)).toHaveLength(1);
    expect(html.match(/paid/g)).toHaveLength(1);
    expect(html).toContain("12:34:56 UTC");
    expect(html).toContain("12:40:00 UTC");
    expect(html).toContain("450,000.00 ISK");
    expect(html).toContain("900,000.00 ISK");
  });

  // A single event has no head to hoist a shared fact into — `payments (1)`
  // renders the list inline with no disclosure at all — so it keeps the full
  // instant, the kind and the actor. Norms need a set to be norms of.
  it("keeps the whole sentence when there is only one event", () => {
    const html = render([payment()]);
    expect(html).toContain("2026-08-01 12:34:56 UTC");
    expect(html).toContain("paid");
    expect(html).toContain("by FC Prime");
    expect(html).not.toContain("All 1");
  });

  // The null case, which is reachable in production: the actor's account was
  // deleted (the FK is `on delete set null`), or it has no main character. The
  // event still renders, and it must not print "null" or leave a gap where a
  // name belongs.
  it("says unknown when the actor no longer resolves", () => {
    const html = render([payment({ actor: null, actorName: null })]);
    expect(html).toContain("by unknown");
    expect(html).not.toContain("null");
  });

  it("renders nothing at all for a participant with no history", () => {
    expect(render([])).toBe("");
  });
});
