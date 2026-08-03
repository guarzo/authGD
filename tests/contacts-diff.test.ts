import { describe, expect, it } from "vitest";
import { diffContacts, type ContactState } from "@/core/contacts-diff";

const LABEL = 7;

const contact = (
  contactId: number,
  standing: number,
  labelIds: number[] = [],
): ContactState => ({ contactId, standing, labelIds });

describe("diffContacts", () => {
  it("adds desired ids that are absent", () => {
    const d = diffContacts({
      desiredIds: [1, 2],
      standing: 5,
      labelId: LABEL,
      contacts: [],
    });
    expect(d).toEqual({ add: [1, 2], update: [], remove: [] });
  });

  it("leaves correct labeled contacts alone", () => {
    const d = diffContacts({
      desiredIds: [1],
      standing: 5,
      labelId: LABEL,
      contacts: [contact(1, 5, [LABEL])],
    });
    expect(d).toEqual({ add: [], update: [], remove: [] });
  });

  it("takes over an existing personal contact, preserving its labels", () => {
    const d = diffContacts({
      desiredIds: [1],
      standing: 5,
      labelId: LABEL,
      contacts: [contact(1, 0, [3])],
    });
    expect(d).toEqual({
      add: [],
      update: [{ contactId: 1, labelIds: [3, LABEL] }],
      remove: [],
    });
  });

  it("re-asserts standing on labeled contacts without duplicating the label", () => {
    const d = diffContacts({
      desiredIds: [1],
      standing: 5,
      labelId: LABEL,
      contacts: [contact(1, -10, [LABEL])],
    });
    expect(d).toEqual({
      add: [],
      update: [{ contactId: 1, labelIds: [LABEL] }],
      remove: [],
    });
  });

  it("removes only OUR labeled contacts that left the desired set", () => {
    const d = diffContacts({
      desiredIds: [1],
      standing: 5,
      labelId: LABEL,
      contacts: [
        contact(1, 5, [LABEL]),
        contact(2, 5, [LABEL]), // ours, no longer desired → delete
        contact(3, 10, []), // personal, unlabeled → NEVER touched
        contact(4, -5, [9]), // personal, other label → NEVER touched
      ],
    });
    expect(d).toEqual({ add: [], update: [], remove: [2] });
  });
});
