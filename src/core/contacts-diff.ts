export type ContactState = {
  contactId: number;
  standing: number;
  labelIds: number[];
};

export type ContactsDiff = {
  add: number[];
  update: Array<{ contactId: number; labelIds: number[] }>;
  remove: number[];
};

/**
 * Label-ownership policy (accepted-destructive, aa-standingssync precedent):
 * the app owns `labelId` outright. Desired ids are added, or taken over if
 * they already exist as personal contacts (standing re-asserted, our label
 * added while PRESERVING existing labels — ESI PUT replaces label_ids
 * wholesale). Contacts carrying our label that leave the desired set are
 * deleted entirely. Contacts never carrying our label are never modified.
 * `desiredIds` must already exclude the target character itself.
 */
export function diffContacts(input: {
  desiredIds: number[];
  standing: number;
  labelId: number;
  contacts: ContactState[];
}): ContactsDiff {
  const desired = new Set(input.desiredIds);
  const byId = new Map(input.contacts.map((c) => [c.contactId, c]));
  const add: number[] = [];
  const update: Array<{ contactId: number; labelIds: number[] }> = [];
  for (const id of input.desiredIds) {
    const existing = byId.get(id);
    if (!existing) {
      add.push(id);
      continue;
    }
    const hasLabel = existing.labelIds.includes(input.labelId);
    if (!hasLabel || existing.standing !== input.standing) {
      update.push({
        contactId: id,
        labelIds: hasLabel ? existing.labelIds : [...existing.labelIds, input.labelId],
      });
    }
  }
  const remove = input.contacts
    .filter((c) => c.labelIds.includes(input.labelId) && !desired.has(c.contactId))
    .map((c) => c.contactId);
  return { add, update, remove };
}
