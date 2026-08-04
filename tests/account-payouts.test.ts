import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountPayouts } from "@/app/account/account-payouts";
import type { AccountPayoutRow } from "@/services/payout-view";

// Renders the section component directly, the way tests/account-page.test.ts
// renders ContactRemedy: the account page itself is an async server component
// that reads the session cookie and the database, so it cannot be rendered
// outside a request. Splitting the section out is what makes the one rule
// that matters here — who gets a link — testable at all.
const rows: AccountPayoutRow[] = [
  {
    operationId: "11111111-1111-4111-8111-111111111111",
    operationName: "Thursday roam",
    occurredAt: new Date("2026-08-01T00:00:00Z"),
    amount: "450000.00",
    paid: true,
  },
  {
    operationId: "22222222-2222-4222-8222-222222222222",
    operationName: "Sunday brawl",
    occurredAt: new Date("2026-07-28T00:00:00Z"),
    amount: "1200.50",
    paid: false,
  },
];

const render = (linkToOperations: boolean) =>
  renderToStaticMarkup(createElement(AccountPayouts, { rows, linkToOperations }));

describe("AccountPayouts", () => {
  it("links each operation for a viewer who can read payouts", () => {
    const html = render(true);
    expect(html).toContain('href="/payouts/11111111-1111-4111-8111-111111111111"');
    expect(html).toContain('href="/payouts/22222222-2222-4222-8222-222222222222"');
  });

  // Reading your own history needs only a session; reading an OPERATION needs
  // tier flygd. A member demoted to blue/green still gets the answer to "did I
  // get paid for that Thursday roam" — and a link that silently redirected
  // them back to /account would be worse than no link.
  it("renders the operation as plain text for a viewer who cannot", () => {
    const html = render(false);
    expect(html).not.toContain('href="/payouts/');
    expect(html).toContain("Thursday roam");
    expect(html).toContain("Sunday brawl");
  });

  it("shows the exact stored amount and each paid state", () => {
    const html = render(false);
    expect(html).toContain("450000.00 ISK");
    expect(html).toContain("1200.50 ISK");
    expect(html).toContain("paid");
    expect(html).toContain("unpaid");
  });

  it("renders the operation date, not a relative time", () => {
    expect(render(false)).toContain("2026-08-01");
  });
});
