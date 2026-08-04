import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ContactState } from "@/app/account/contact-state";

// The job stores near-miss candidates as a JSON array (src/core/contact-label.ts),
// and tests/contacts-job.test.ts only asserts that encoded value at the DB
// layer. This is the only seam that covers what the member actually reads: a
// two-candidate detail must render as two separately-quoted names, never as
// one quoted blob that isn't the name of any label the member has.
describe("ContactState (label_mismatch render)", () => {
  const render = (detail: string | null) =>
    renderToStaticMarkup(
      createElement(ContactState, {
        result: "label_mismatch",
        detail,
        label: "AuthGD",
        target: true,
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
  });
});

// STANDINGS_LABEL is operator-supplied and matchContactLabel folds surrounding
// whitespace off the required name too, so a padded config value is reachable.
// This branch fires far more often than label_mismatch; if it names the label
// without the quoted `literal` treatment, a member is told to create a label
// whose exact characters they cannot see — the incident this feature exists to
// prevent, one branch over.
describe("ContactState (missing_label render)", () => {
  it("quotes the required label so its whitespace is visible", () => {
    const html = renderToStaticMarkup(
      createElement(ContactState, {
        result: "missing_label",
        detail: null,
        label: "AuthGD ",
        target: true,
      }),
    );
    expect(html).toContain("Create a contact label named");
    expect(html).toContain('class="literal"');
    expect(html).toContain("&quot;AuthGD &quot;");
  });
});
