import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CONTACT_SYNC_RESULTS } from "@/core/contact-result";
import { ContactRemedy, ContactState } from "@/app/account/contact-state";
import { computeAccountHealth } from "@/core/account-health";

/**
 * The union's payoff. `ContactSyncResult` makes the WRITER's literals
 * checkable, but nothing in the type system forces the READERS to grow a
 * branch when a code is added — they take `string`, on purpose, because a code
 * from an older deployment is reachable at runtime (see contact-result.ts).
 *
 * These tests close that gap from the other side: every code the job can
 * currently write must produce real UI, and adding one to CONTACT_SYNC_RESULTS
 * without writing its copy fails here rather than shipping a member a raw
 * identifier. The graceful fallback stays for codes NOT in the union, which is
 * its actual job.
 */
describe("every contacts result code has UI copy", () => {
  // A smoke check, and deliberately no more. ContactState's fallback renders
  // `result.replace(/_/g, " ")` in a bad-toned token, which for several codes
  // is character-for-character what their real branch renders ("token invalid"
  // is both). There is no assertion that separates handled from fallen-through
  // here, so this claims only that the token exists and carries a tone. The
  // drift that matters is caught by the ContactRemedy case below, where the
  // fallback has copy of its own.
  it.each(CONTACT_SYNC_RESULTS)("ContactState renders a token for %s", (result) => {
    const html = renderToStaticMarkup(
      createElement(ContactState, { result, target: true }),
    );
    expect(html).toContain('class="st');
    // No raw identifier leaked. Not a drift check either way: the fallback
    // strips underscores too. `result` itself is unusable here because "ok"
    // is a substring of its own tone class.
    expect(html).not.toContain("_");
  });

  it.each(CONTACT_SYNC_RESULTS.filter((r) => r !== "ok"))(
    "ContactRemedy explains %s without falling through to the unknown-code copy",
    (result) => {
      const html = renderToStaticMarkup(
        createElement(ContactRemedy, {
          result,
          detail: null,
          label: "AuthGD",
          showReauth: true,
        }),
      );
      expect(html).not.toBe("");
      expect(html).not.toContain("Unrecognized result");
    },
  );

  it("renders no remedy for ok, which is the one code with nothing to explain", () => {
    expect(
      renderToStaticMarkup(
        createElement(ContactRemedy, { result: "ok", detail: null, label: "AuthGD" }),
      ),
    ).toBe("");
  });

  // computeAccountHealth splits the vocabulary in two and the split must be
  // total: a code in neither bucket would leave a character silently absent
  // from a verdict that claims to describe the whole account.
  it.each(CONTACT_SYNC_RESULTS.filter((r) => r !== "ok"))(
    "the verdict classifies %s as either needing attention or stalled",
    (result) => {
      const h = computeAccountHealth(
        [
          {
            tokenStatus: "valid",
            needsReauthForScopes: false,
            contactsTarget: true,
            contactSyncResult: result,
          },
        ],
        { linked: false, lastPushedAt: null, now: new Date("2026-01-05T15:19:00.000Z") },
      );
      expect(h.attention + h.stalled).toBe(1);
      expect(h.verdict).not.toBe("nominal");
    },
  );

  it("classifies ok as nominal", () => {
    const h = computeAccountHealth(
      [
        {
          tokenStatus: "valid",
          needsReauthForScopes: false,
          contactsTarget: true,
          contactSyncResult: "ok",
        },
      ],
      { linked: false, lastPushedAt: null, now: new Date("2026-01-05T15:19:00.000Z") },
    );
    expect(h).toEqual({
      attention: 0,
      stalled: 0,
      firstSyncPending: false,
      discordStale: false,
      verdict: "nominal",
    });
  });
});
