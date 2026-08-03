import { describe, expect, it } from "vitest";
import { diffAcl } from "@/core/acl-diff";

describe("diffAcl", () => {
  it("adds missing desired members and removes undesired ones", () => {
    expect(
      diffAcl({
        desiredIds: [1, 2],
        members: [
          { characterId: 2, role: "member" },
          { characterId: 3, role: "member" },
        ],
      }),
    ).toEqual({ add: [1], remove: [3], unblock: [] });
  });

  it("NEVER removes admin-role entries; managers are removable", () => {
    expect(
      diffAcl({
        desiredIds: [],
        members: [
          { characterId: 1, role: "admin" },
          { characterId: 2, role: "manager" },
          { characterId: 3, role: "member" },
        ],
      }),
    ).toEqual({ add: [], remove: [2, 3], unblock: [] });
  });

  it("unblocks desired blocked members, preserving all other roles", () => {
    expect(
      diffAcl({
        desiredIds: [1, 2, 3, 4],
        members: [
          { characterId: 1, role: "blocked" }, // desired but blocked → unblock
          { characterId: 2, role: "manager" }, // elevated → preserved
          { characterId: 3, role: "viewer" }, // normal → preserved
          { characterId: 4, role: "admin" }, // elevated → preserved
          { characterId: 5, role: "blocked" }, // blocked AND undesired → removed
        ],
      }),
    ).toEqual({ add: [], remove: [5], unblock: [1] });
  });

  it("is a no-op when converged", () => {
    expect(
      diffAcl({ desiredIds: [1], members: [{ characterId: 1, role: "member" }] }),
    ).toEqual({ add: [], remove: [], unblock: [] });
  });
});
