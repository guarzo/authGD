import { describe, expect, it } from "vitest";
import { inSection, navFor, navFromPath } from "@/app/_components/nav-items";

const labels = (items: { label: string }[]) => items.map((i) => i.label);

/**
 * The shell's one nav rule. It is a pure function of two booleans, so the
 * membership half is cheap to pin here; what the e2e suite adds on top is that
 * the *right* two booleans reach it on each real surface.
 */
describe("navFor", () => {
  it("gives a viewer who can prove nothing exactly one destination", () => {
    expect(labels(navFor({ canReadPayouts: false, isAdmin: false }))).toEqual([
      "Your account",
    ]);
  });

  // The pair that made the uniform-nav option unworkable: isAdmin and tier are
  // orthogonal columns (db/schema.ts) and the default tier is `alumni`, so an
  // admin is routinely NOT a payouts reader. Offering Operations off the admin
  // bit alone would hand that ordinary account a link that redirects it
  // straight back out.
  it("keeps the admin bit and the payouts bit independent", () => {
    expect(labels(navFor({ canReadPayouts: false, isAdmin: true }))).toEqual([
      "Your account",
      "Members",
      "Audit log",
      "Sync",
      "Access lists",
      "Structures",
    ]);
    expect(labels(navFor({ canReadPayouts: true, isAdmin: false }))).toEqual([
      "Your account",
      "Operations",
    ]);
  });

  it("orders every reach the same way, broadest access first", () => {
    expect(labels(navFor({ canReadPayouts: true, isAdmin: true }))).toEqual([
      "Your account",
      "Operations",
      "Members",
      "Audit log",
      "Sync",
      "Access lists",
      "Structures",
    ]);
  });

  it("offers Structures to admins and nobody else", () => {
    expect(labels(navFor({ canReadPayouts: false, isAdmin: true }))).toContain(
      "Structures",
    );
    expect(labels(navFor({ canReadPayouts: false, isAdmin: false }))).not.toContain(
      "Structures",
    );
  });

  // Module-level constants are shared across every call in a server process.
  // A call site that mutated an item rather than spreading it (as admin-nav.tsx
  // does for the pending badge) would corrupt the bar for every later render.
  it("hands back items that are the same objects on every call", () => {
    const first = navFor({ canReadPayouts: true, isAdmin: true });
    const second = navFor({ canReadPayouts: true, isAdmin: true });
    expect(first).not.toBe(second);
    first.forEach((item, i) => expect(item).toBe(second[i]));
  });
});

describe("navFromPath", () => {
  it("reads /admin/* as the admin bit and nothing about tier", () => {
    expect(labels(navFromPath("/admin/audit"))).toEqual([
      "Your account",
      "Members",
      "Audit log",
      "Sync",
      "Access lists",
      "Structures",
    ]);
  });

  it("reads /payouts/* as the payouts bit and nothing about isAdmin", () => {
    expect(labels(navFromPath("/payouts/abc"))).toEqual(["Your account", "Operations"]);
  });

  it("reads an unguarded path as proving neither", () => {
    expect(labels(navFromPath("/no-such-page"))).toEqual(["Your account"]);
  });

  // A path that merely shares a prefix cleared none of the guards the branches
  // above cite. No such route exists today — an unmatched URL renders the root
  // not-found boundary, which calls navFor directly — so this pins the rule
  // for the sibling route that makes it reachable.
  it("does not treat a prefix-sharing sibling as being in the section", () => {
    expect(labels(navFromPath("/admin-old"))).toEqual(["Your account"]);
    expect(labels(navFromPath("/payouts-archive"))).toEqual(["Your account"]);
  });
});

describe("inSection", () => {
  it("matches the section root and anything under it", () => {
    expect(inSection("/admin", "/admin")).toBe(true);
    expect(inSection("/admin/sync", "/admin")).toBe(true);
  });

  it("rejects a path that only shares the prefix", () => {
    expect(inSection("/administration", "/admin")).toBe(false);
    expect(inSection("/adminish/sync", "/admin")).toBe(false);
  });
});
