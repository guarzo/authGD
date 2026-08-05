import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ContactRemedy } from "@/app/account/contact-state";
import { StandingTier } from "@/app/account/standing";
import type { Tier } from "@/core/tier";

// The job stores near-miss candidates as a JSON array (src/core/contact-label.ts),
// and tests/contacts-job.test.ts only asserts that encoded value at the DB
// layer. This is the only seam that covers what the member actually reads: a
// two-candidate detail must render as two separately-quoted names, never as
// one quoted blob that isn't the name of any label the member has.
//
// Renders ContactRemedy directly rather than ContactState: the status token
// and the explanatory prose are separate exports of the same module (the
// prose lives below the table on the account page, not inside the cell), and
// this suite only covers what the member reads to fix the state.
describe("ContactRemedy (label_mismatch render)", () => {
  const render = (detail: string | null) =>
    renderToStaticMarkup(
      createElement(ContactRemedy, {
        result: "label_mismatch",
        detail,
        label: "AuthGD",
      }),
    );
  const encoded = (...candidates: string[]) => render(JSON.stringify(candidates));

  it("quotes a single candidate as one name", () => {
    const html = encoded("AUTHGD");
    expect(html).toContain("Your label is named");
    expect(html).toContain("&quot;AUTHGD&quot;");
    // No joined blob, and no plural copy.
    expect(html).not.toContain("Labels named");
  });

  // Speech output normalizes whitespace and doesn't announce case, so the
  // quoted literals alone read as identical strings. The sentence must name
  // the axis of difference in words so it stands on its own.
  it("states the difference in words for a case-only near miss", () => {
    const html = encoded("AUTHGD");
    expect(html).toContain("differs from");
    expect(html).toContain("only in capitalization");
    expect(html).not.toContain("only in spacing");
    expect(html).toContain("nothing else to do here");
  });

  it("states the difference in words for a spacing-only near miss", () => {
    const html = encoded("AuthGD ");
    expect(html).toContain("only in spacing");
    expect(html).not.toContain("only in capitalization");
  });

  it("states the difference in words for a combined case-and-spacing near miss", () => {
    const html = encoded(" authgd ");
    expect(html).toContain("in both capitalization and spacing");
  });

  it("quotes each of two candidates separately, not as one joined name", () => {
    const html = encoded("AUTHGD", "authgd ");
    // Each candidate appears in its own quote marks...
    expect(html).toContain("&quot;AUTHGD&quot;");
    expect(html).toContain("&quot;authgd &quot;");
    // ...and the joined blob never appears as a single quoted string.
    expect(html).not.toContain("&quot;AUTHGD, authgd &quot;");
    expect(html).toContain("Labels named");
    expect(html).toContain("both differ only in capitalization or spacing");
  });

  it("quotes three or more candidates separately and uses plural copy", () => {
    const html = encoded("AUTHGD", "authgd", "AuthGD ");
    expect(html).toContain("&quot;AUTHGD&quot;");
    expect(html).toContain("&quot;authgd&quot;");
    expect(html).toContain("&quot;AuthGD &quot;");
    expect(html).not.toContain("&quot;AUTHGD, authgd, AuthGD &quot;");
    expect(html).toContain("all differ only in capitalization or spacing");
  });

  // The reason the storage format is JSON rather than a `", "` join: every
  // candidate is a fold-equal variant of STANDINGS_LABEL, so a label containing
  // the delimiter makes EVERY candidate contain it, and a split would name
  // four labels the member does not have instead of the two they do.
  it("keeps candidates whose own names contain the comma delimiter intact", () => {
    const html = encoded("Auth, GD", "auth, gd");
    expect(html).toContain("&quot;Auth, GD&quot;");
    expect(html).toContain("&quot;auth, gd&quot;");
    expect(html).not.toContain("&quot;Auth&quot;");
    expect(html).not.toContain("&quot;GD&quot;");
  });

  it("preserves repeated internal spaces in a candidate", () => {
    const html = encoded("Auth  GD");
    expect(html).toContain("&quot;Auth  GD&quot;");
  });

  // Rows written before the JSON encoding still hold a `", "` join, and the
  // contacts job only rewrites a row when it next runs for that character.
  it("falls back to the legacy delimiter split for pre-JSON rows", () => {
    const html = render("AUTHGD, authgd ");
    expect(html).toContain("&quot;AUTHGD&quot;");
    expect(html).toContain("&quot;authgd &quot;");
    expect(html).toContain("Labels named");
  });

  it("falls back to the no-detail copy when detail is null", () => {
    const html = render(null);
    expect(html).toContain("A label differing only in capitalization or spacing exists");
    expect(html).not.toContain("Labels named");
    expect(html).toContain("nothing else to do here");
  });
});

// STANDINGS_LABEL is operator-supplied and matchContactLabel folds surrounding
// whitespace off the required name too, so a padded config value is reachable.
// This branch fires far more often than label_mismatch; if it names the label
// without the quoted `literal` treatment, a member is told to create a label
// whose exact characters they cannot see — the incident this feature exists to
// prevent, one branch over.
describe("ContactRemedy (missing_label render)", () => {
  it("quotes the required label so its whitespace is visible", () => {
    const html = renderToStaticMarkup(
      createElement(ContactRemedy, {
        result: "missing_label",
        detail: null,
        label: "AuthGD ",
      }),
    );
    expect(html).toContain("Create a contact label named");
    expect(html).toContain('class="literal"');
    expect(html).toContain("&quot;AuthGD &quot;");
    expect(html).toContain("nothing else to do here");
  });
});

// The six job-failure codes that used to fall through to a bare, alarm-red
// code with zero guidance (contact-state.tsx previously did
// `result.replace(/_/g, " ")`). Each now gets one of three treatments.
describe("ContactRemedy (job-failure codes)", () => {
  const render = (result: string, showReauth = true) =>
    renderToStaticMarkup(
      createElement(ContactRemedy, { result, detail: null, label: "AuthGD", showReauth }),
    );

  it.each(["token_invalid", "missing_scope", "needs_reauth"])(
    "tells the member to re-authorize for %s",
    (result) => {
      const html = render(result);
      expect(html).toContain("re-authorize");
      expect(html).toContain('href="/auth/eve/link"');
    },
  );

  // `/auth/eve/link` links a character to *the clicking user's* account, so the
  // control is only ever correct for the character's own owner. The admin
  // accounts table renders this same component for other members' characters
  // and must never get a link that would attach one to the admin instead.
  it.each(["token_invalid", "missing_scope", "needs_reauth"])(
    "withholds the control but keeps the reason for %s when not self-service",
    (result) => {
      const html = render(result, false);
      expect(html).not.toContain("href=");
      expect(html).toContain("Re-linking the character clears it.");
    },
  );

  it("defaults to withholding the re-authorize control", () => {
    const html = renderToStaticMarkup(
      createElement(ContactRemedy, {
        result: "token_invalid",
        detail: null,
        label: "AuthGD",
      }),
    );
    expect(html).not.toContain("href=");
  });

  it.each(["token_refresh_failed", "sync_failed"])(
    "reads as transient and automatic for %s, with nothing to do",
    (result) => {
      const html = render(result);
      expect(html).toContain("automatically");
      expect(html).toContain("No action needed");
      // The label remedies own "nothing to do here", where it means "nothing
      // more to do in authGD" and follows an imperative to act in game. These
      // codes ask nothing of anyone, so they must not borrow that phrase.
      expect(html).not.toContain("othing to do here");
      expect(html).not.toContain("re-authorize");
    },
  );

  it("attributes dry_run to an operator setting, not the member", () => {
    const html = render("dry_run");
    expect(html).toContain("operator setting");
    expect(html).toContain("admin");
    expect(html).not.toContain("re-authorize");
  });

  it("gives an unrecognised code a sentence instead of a bare code", () => {
    const html = render("some_future_code");
    expect(html).toContain("Unrecognized result");
    expect(html).toContain("&quot;some_future_code&quot;");
    expect(html).toContain("admin");
  });

  it("renders nothing for ok or a null result", () => {
    expect(render("ok")).toBe("");
    expect(
      renderToStaticMarkup(
        createElement(ContactRemedy, { result: null, detail: null, label: "AuthGD" }),
      ),
    ).toBe("");
  });
});

describe("StandingTier", () => {
  const render = (tier: Tier) =>
    renderToStaticMarkup(createElement(StandingTier, { tier }));

  it("tells a pending member their access is awaiting approval", () => {
    const html = render("pending");
    expect(html).toContain("awaiting approval");
    // No tier badge: pending is the absence of a granted tier, and a badge
    // would imply the member holds one.
    expect(html).not.toContain("tier--");
  });

  it("still renders a badge for a granted tier", () => {
    expect(render("green")).toContain("tier--green");
  });
});
