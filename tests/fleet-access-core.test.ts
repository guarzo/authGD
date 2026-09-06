import { expect, it } from "vitest";
import { linkedFleetCharacters } from "@/core/fleet-access";

it("includes linked fleet alts, excluding unrelated members and out-of-fleet alts", () => {
  const anchor = { characterId: 90000001, characterName: "Anchor" };
  const alt = { characterId: 90000002, characterName: "Linked Alt" };
  const outside = { characterId: 90000003, characterName: "Outside" };
  const linked = [outside, alt, anchor];
  expect(linkedFleetCharacters(linked, [90000001, 90000002, 90000099])).toEqual([
    anchor,
    alt,
  ]);
  expect(linked).toEqual([outside, alt, anchor]);
});

it("does not duplicate a linked character for repeated roster IDs or fabricate matches", () => {
  const anchor = { characterId: 90000001, characterName: "Anchor" };
  expect(linkedFleetCharacters([anchor], [90000001, 90000001])).toEqual([anchor]);
  expect(linkedFleetCharacters([anchor], [])).toEqual([]);
  expect(linkedFleetCharacters([], [90000001])).toEqual([]);
});
