import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ContactRemedy } from "@/app/account/contact-state";
import { StandingTier } from "@/app/account/standing";
import { accountConfirmation } from "@/app/account/view";
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

  it("reassures a stale single-candidate row instead of demanding a rename", () => {
    const html = encoded("AUTHGD");
    expect(html).toContain("Your label is named");
    expect(html).toContain("&quot;AUTHGD&quot;");
    expect(html).toContain("only in capitalization");
    expect(html).toContain("authGD accepts it as-is");
    expect(html).not.toContain("Rename it in game");
    expect(html).not.toContain("It must be exactly");
  });

  // `label` is the live STANDINGS_LABEL, `detail` came from the stored row
  // (src/app/account/page.tsx). An operator who recapitalized the config after
  // the row was written leaves a candidate the next sync will NOT accept, so
  // this branch must promise nothing about it.
  it("tells the member to rename when the stored candidate no longer folds equal", () => {
    const html = encoded("Blues");
    expect(html).toContain("&quot;Blues&quot;");
    expect(html).toContain("authGD is now looking for");
    expect(html).toContain("Rename it in game");
    expect(html).not.toContain("accepts it as-is");
  });

  it("says nothing to do when the config moved onto the stored candidate", () => {
    const html = encoded("AuthGD");
    expect(html).toContain("already matches");
    expect(html).not.toContain("Rename it in game");
  });

  // The regression this whole gate exists for. describeLabelDifference
  // collapses internal whitespace runs and calls this pair "spacing", but
  // matchContactLabel only trims, so the next sync records missing_label.
  // Gating the reassurance on that helper would promise acceptance here.
  // Rendered directly rather than through `render`, which pins label to
  // "AuthGD".
  it("does not promise acceptance when the candidate differs by an internal run", () => {
    const html = renderToStaticMarkup(
      createElement(ContactRemedy, {
        result: "label_mismatch",
        detail: JSON.stringify(["Auth  GD"]),
        label: "Auth GD",
      }),
    );
    expect(html).toContain("authGD is now looking for");
    expect(html).toContain("Rename it in game");
    expect(html).not.toContain("accepts it as-is");
  });

  // Speech output normalizes whitespace and doesn't announce case, so the
  // quoted literals alone read as identical strings. The sentence must name
  // the axis of difference in words so it stands on its own.
  it("states the difference in words for a case-only near miss", () => {
    const html = encoded("AUTHGD");
    expect(html).toContain("differs from");
    expect(html).toContain("only in capitalization");
    expect(html).not.toContain("only in spacing");
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

  it("asks a two-candidate member to remove one, not to rename to an exact name", () => {
    const html = encoded("AUTHGD", "authgd ");
    expect(html).toContain("&quot;AUTHGD&quot;");
    expect(html).toContain("&quot;authgd &quot;");
    expect(html).not.toContain("&quot;AUTHGD, authgd &quot;");
    expect(html).toContain("Labels named");
    expect(html).toContain("both differ only in capitalization or spacing");
    expect(html).toContain("cannot tell which one you mean");
    expect(html).not.toContain("It must be exactly");
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
    expect(html).toContain("More than one of your labels differs only in capitalization");
    expect(html).not.toContain("Labels named");
    expect(html).toContain("The next sync picks it up.");
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
    expect(html).toContain("The next sync picks it up.");
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
    renderToStaticMarkup(createElement(StandingTier, { tier, canFixMain: false }));

  it("tells a pending member their access is awaiting approval", () => {
    const html = render("pending");
    expect(html).toContain("awaiting approval");
    // No tier badge: pending is the absence of a granted tier, and a badge
    // would imply the member holds one.
    expect(html).not.toContain("tier--");
  });

  it("still renders a badge for a granted tier", () => {
    expect(render("alumni")).toContain("tier--alumni");
  });
});

describe("StandingTier (main-fix hint)", () => {
  const render = (tier: Tier, canFixMain: boolean) =>
    renderToStaticMarkup(createElement(StandingTier, { tier, canFixMain }));

  it("tells a stalled pending account which character is the problem", () => {
    const html = render("pending", true);
    expect(html).toContain("alliance");
    expect(html).toContain("ask an admin");
    // The old copy promised a review that will never come while the main is
    // out of alliance — decideTier holds pending accounts until it isn't.
    expect(html).not.toContain("awaiting approval");
  });

  it("leaves the ordinary pending message alone", () => {
    const html = render("pending", false);
    expect(html).toContain("awaiting approval");
    expect(html).not.toContain("ask an admin");
  });

  it("stops promising an alumni account that this reverts on its own", () => {
    const html = render("alumni", true);
    expect(html).toContain("ask an admin");
    expect(html).not.toContain("reverts on its own");
  });

  it("keeps the self-correcting promise for a genuinely out-of-alliance account", () => {
    const html = render("alumni", false);
    expect(html).toContain("reverts on its own");
  });
});

// The success confirmation the four /account server actions redirect back
// with — setMainAction, unlinkAction, wakeSelfAction, unlinkDiscordAction all
// end in a control unmounting, and this is the only evidence a member gets
// that the press landed. `done` and `name` arrive off the query string,
// exactly like `queuedNotice`'s `queued`/`at` in admin/sync/view.ts, so an
// unrecognized or missing value is untrusted input reaching copy and has to
// degrade rather than throw or print garbage.
describe("accountConfirmation", () => {
  it("names the character for a main-character change", () => {
    expect(accountConfirmation("main", "Aiden Sol")).toBe(
      "Main character set to Aiden Sol.",
    );
  });

  it("falls back to a bare verb when the name didn't survive the redirect", () => {
    expect(accountConfirmation("main", undefined)).toBe("Main character updated.");
  });

  it("confirms an unlink without repeating the character's name", () => {
    expect(accountConfirmation("unlink", "Someone Else")).toBe("Character unlinked.");
  });

  it("names both halves of leaving cryo: the state change and the resync", () => {
    expect(accountConfirmation("wake", undefined)).toBe("Active again. Sync queued.");
  });

  it("confirms a Discord unlink", () => {
    expect(accountConfirmation("discord", undefined)).toBe("Discord unlinked.");
  });

  it("renders nothing for a missing done code", () => {
    expect(accountConfirmation(undefined, undefined)).toBe("");
  });

  it("renders nothing for a done code this build doesn't recognize", () => {
    // A hand-typed `?done=` (or one a future rollback no longer emits) must
    // not silently pass through to become copy on the page.
    expect(accountConfirmation("delete_account", undefined)).toBe("");
  });
});
