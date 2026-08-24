import { describe, expect, it } from "vitest";
import {
  monitorRemedy,
  monitorSentence,
  monitorState,
} from "@/app/admin/structures/view";
import type { HolderView } from "@/services/structures";
import { NOTIFICATIONS_SCOPE, STRUCTURES_SCOPE } from "@/lib/esi/client";

function healthyHolder(): HolderView {
  return {
    characterId: 1,
    name: "Test Holder",
    scopes: [STRUCTURES_SCOPE, NOTIFICATIONS_SCOPE],
    tokenStatus: "valid",
    corporationId: 5,
    currentCorporationId: 5,
  };
}

const base = {
  grantable: null,
  holder: null,
  readStates: {},
  rosterCount: 0,
  webhookConfigured: true,
};

describe("monitorState", () => {
  it("asks for a grant when nobody has one", () => {
    expect(monitorState(base)).toBe("grant-needed");
  });

  it("asks for a designation when a character has the scopes but is not the holder", () => {
    expect(monitorState({ ...base, grantable: { characterId: 1, name: "A" } })).toBe(
      "designate-needed",
    );
  });

  it("puts the dropped scope BEFORE the token fault", () => {
    // the plain re-auth link is what DROPS the scope, so offering it first
    // sends an admin round a loop that cannot terminate
    const state = monitorState({
      ...base,
      holder: {
        characterId: 1,
        name: "A",
        scopes: [],
        tokenStatus: "needs_reauth",
        corporationId: 5,
        currentCorporationId: 5,
      },
    });
    expect(state).toBe("scope-dropped");
  });

  it("reports corp-changed when the holder has left the pinned corp", () => {
    expect(
      monitorState({
        ...base,
        holder: {
          characterId: 1,
          name: "A",
          scopes: [STRUCTURES_SCOPE, NOTIFICATIONS_SCOPE],
          tokenStatus: "valid",
          corporationId: 5,
          currentCorporationId: 6,
        },
      }),
    ).toBe("corp-changed");
  });

  it("names which read is forbidden", () => {
    const state = monitorState({
      ...base,
      holder: healthyHolder(),
      readStates: { events: { readStatus: "forbidden" } },
    });
    expect(state).toBe("no-corp-roles");
    expect(monitorSentence(state, { forbidden: ["events"] })).toContain("notifications");
  });

  it("says alerts are unconfigured rather than claiming they go to Discord", () => {
    expect(
      monitorState({
        ...base,
        holder: healthyHolder(),
        rosterCount: 3,
        webhookConfigured: false,
      }),
    ).toBe("alerts-unconfigured");
    expect(monitorState({ ...base, holder: healthyHolder(), rosterCount: 3 })).toBe(
      "normal",
    );
  });

  it("offers no remedy for states an admin cannot fix from this app", () => {
    expect(monitorRemedy("no-corp-roles")).toBeNull();
    expect(monitorRemedy("alerts-unconfigured")).toBeNull();
    expect(monitorRemedy("grant-needed")).toMatchObject({
      href: "/auth/eve/link?grant=structures",
    });
  });

  it("uses the re-grant link for a dropped scope and the bare link for a token fault", () => {
    expect(monitorRemedy("scope-dropped")?.href).toBe("/auth/eve/link?grant=structures");
    expect(monitorRemedy("holder-needs-reauth")?.href).toBe("/auth/eve/link");
  });
});
