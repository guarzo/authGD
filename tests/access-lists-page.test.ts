import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccessListDetail } from "@/app/admin/access-lists/page";
import type { AccessListComparison, RosterCharacter } from "@/core/access-list-compare";

// Pins the page side of the two-sided fix described at
// `src/jobs/access-lists.ts` (roster corp ids join `observedIds`) and
// `src/app/admin/access-lists/page.tsx` (`lookupEntityNames` reads them back):
// a "Missing access" row must print a member's corporation NAME whenever the
// id happens to be in the cache, not the bare `#id` the job never bought.
// Rendered directly rather than through the whole page — `AccessListDetail`
// is the only piece that reads `names.get(m.corporationId)`
// (`tests/account-page.test.ts` uses the same direct-component pattern for a
// server-only page).

function comparison(over: Partial<AccessListComparison> = {}): AccessListComparison {
  return {
    missingAccess: [],
    nonMembers: [],
    matched: 0,
    broadGrants: [],
    ...over,
  };
}

const MEMBER: RosterCharacter = {
  characterId: 1,
  name: "Some Pilot",
  accountId: "acc-1",
  corporationId: 98_000_123,
  allianceId: null,
};

function renderDetail(names: Map<number, string>, missingAccess: RosterCharacter[]) {
  return renderToStaticMarkup(
    createElement(AccessListDetail, {
      detail: null,
      readStatus: "ok",
      comparison: comparison({ missingAccess }),
      names,
    }),
  );
}

describe("AccessListDetail (Missing access → Corporation column)", () => {
  it("prints the corp name when the id is cached", () => {
    const html = renderDetail(new Map([[98_000_123, "Test Corp"]]), [MEMBER]);
    expect(html).toContain("Test Corp");
    expect(html).not.toContain("#98000123");
  });

  it("falls back to the bare id when the corp name is not cached", () => {
    const html = renderDetail(new Map(), [MEMBER]);
    expect(html).toContain("#98000123");
  });

  it("renders — for a member whose affiliation is unknown, never a bare id", () => {
    const html = renderDetail(new Map(), [{ ...MEMBER, corporationId: null }]);
    expect(html).toContain("—");
    expect(html).not.toContain("#null");
  });
});
