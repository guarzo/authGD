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
    expect(html).toContain("2026-08-01 12:34:56 UTC");
    expect(html).toContain("450000.00 ISK");
    expect(html).toContain("reverted");
    expect(html).toContain("FC Prime");
    expect(html).toContain("Second FC");
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
