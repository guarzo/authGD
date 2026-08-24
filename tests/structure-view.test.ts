import { describe, expect, it } from "vitest";
import {
  monitorRemedy,
  monitorSentence,
  monitorState,
  showsRoster,
  rowTone,
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

  it("returns holder-needs-reauth when the holder needs to sign in again", () => {
    expect(
      monitorState({
        ...base,
        holder: {
          characterId: 1,
          name: "A",
          scopes: [STRUCTURES_SCOPE, NOTIFICATIONS_SCOPE],
          tokenStatus: "needs_reauth",
          corporationId: 5,
          currentCorporationId: 5,
        },
      }),
    ).toBe("holder-needs-reauth");
  });

  it("returns holder-no-token for both missing and invalid token statuses", () => {
    expect(
      monitorState({
        ...base,
        holder: {
          characterId: 1,
          name: "A",
          scopes: [STRUCTURES_SCOPE, NOTIFICATIONS_SCOPE],
          tokenStatus: "missing",
          corporationId: 5,
          currentCorporationId: 5,
        },
      }),
    ).toBe("holder-no-token");
    expect(
      monitorState({
        ...base,
        holder: {
          characterId: 1,
          name: "A",
          scopes: [STRUCTURES_SCOPE, NOTIFICATIONS_SCOPE],
          tokenStatus: "invalid",
          corporationId: 5,
          currentCorporationId: 5,
        },
      }),
    ).toBe("holder-no-token");
  });

  it("returns roster-empty when the healthy holder has no structures to read", () => {
    expect(
      monitorState({
        ...base,
        holder: healthyHolder(),
        rosterCount: 0,
      }),
    ).toBe("roster-empty");
  });
});

describe("showsRoster", () => {
  it("renders roster for normal and alert-unconfigured states", () => {
    expect(showsRoster("normal")).toBe(true);
    expect(showsRoster("alerts-unconfigured")).toBe(true);
  });

  it("renders roster for broken states where seeing what is known matters", () => {
    expect(showsRoster("no-corp-roles")).toBe(true);
    expect(showsRoster("corp-changed")).toBe(true);
  });

  it("does not render roster for states with no data to show", () => {
    expect(showsRoster("grant-needed")).toBe(false);
    expect(showsRoster("roster-empty")).toBe(false);
  });
});

describe("rowTone", () => {
  it("marks hull and armor reinforce states as bad — the fight is still on", () => {
    expect(rowTone("hull_reinforce")).toBe("bad");
    expect(rowTone("armor_reinforce")).toBe("bad");
  });

  it("marks vulnerable states as warn", () => {
    expect(rowTone("shield_vulnerable")).toBe("warn");
    expect(rowTone("armor_vulnerable")).toBe("warn");
    expect(rowTone("unknown_vulnerable")).toBe("warn");
  });

  it("marks healthy states as neutral", () => {
    expect(rowTone("online")).toBe("neutral");
    expect(rowTone("unknown_state")).toBe("neutral");
  });
});
