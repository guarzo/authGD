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
  // tier member. A member demoted to associate/alumni still gets the answer to "did I
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
    // 450000.00 groups to 450,000.00 via fmtIsk — see the dedicated test below.
    expect(html).toContain("450,000.00 ISK");
    expect(html).toContain("1,200.50 ISK");
    // Anchored on the element boundary: "unpaid" contains "paid", so a bare
    // toContain("paid") passes on a render where every row is unpaid and this
    // test would never notice the paid badge going missing.
    expect(html).toContain(">paid<");
    expect(html).toContain(">unpaid<");
  });

  // fmtIsk groups the integer part in threes (src/app/_components/format-isk.ts);
  // this is the seam that proves the row actually renders through it rather
  // than the raw numeric(20,2) string.
  it("groups the amount via fmtIsk", () => {
    const grouped: AccountPayoutRow[] = [
      {
        operationId: "33333333-3333-4333-8333-333333333333",
        operationName: "Big op",
        occurredAt: new Date("2026-08-01T00:00:00Z"),
        amount: "4821430000.00",
        paid: true,
      },
    ];
    const html = renderToStaticMarkup(
      createElement(AccountPayouts, { rows: grouped, linkToOperations: true }),
    );
    expect(html).toContain("4,821,430,000.00 ISK");
    expect(html).not.toContain("4821430000.00 ISK");
  });

  it("renders the operation date, not a relative time", () => {
    expect(render(false)).toContain("2026-08-01");
  });

  // The other half of "demoted, not booted": without this line the operation
  // names below silently stop being links, with nothing said about why.
  it("explains that operation pages are Member-only when the viewer can't reach them", () => {
    const html = render(false);
    expect(html).toContain("Member-only");
    expect(html).toContain("stays regardless of tier");
  });

  it("omits the Member-only line for a viewer who can reach operations", () => {
    const html = render(true);
    expect(html).not.toContain("Member-only");
  });
});
