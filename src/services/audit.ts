import type { Dbx } from "@/db";
import { JOB_CRON } from "@/core/schedules";
import { account, auditLog, character, discordLink, payoutOperation } from "@/db/schema";
import { and, desc, eq, inArray, like, lt, sql } from "drizzle-orm";

export const AUDIT_PAGE_SIZE = 100;

export async function logAudit(
  dbx: Dbx,
  entry: {
    actor: string;
    action: string;
    target: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await dbx.insert(auditLog).values(entry);
}

// `jsonb` does not preserve key order (Postgres canonicalizes its own way on
// write), so a row read back can list the same keys in a different order than
// the plain object this module builds them in. A raw `JSON.stringify`
// comparison would treat that reordering as a change and defeat the dedupe on
// every single call — sort keys first so only the actual content is compared.
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/**
 * `logAudit`, but silent when the most recent row for this exact
 * `action`+`target` already carries the same `details`. Written for
 * hourly-cron failure reporting (discord-roles is the first caller): a
 * permanent failure — a role hierarchy change, a bot missing permission, a
 * member the API rejects outright — reproduces identically every tick for as
 * long as its cause persists, and with plain `logAudit` that is one row per
 * tick forever. This still writes the FIRST occurrence (nothing to compare
 * against) and writes again the moment `details` changes (the failure moved
 * on, or resolved and came back differently) — it collapses reruns of the
 * unchanged failure, it does not suppress the failure itself.
 *
 * Costs one extra lookup per call, served by `audit_log_action_target_id_idx`
 * on `(action, target, id desc)` — an equality match on both leading columns,
 * which is what that index answers. It does not help `queryAuditLog`'s action
 * filter, which is a LIKE prefix — `audit_log_action_pattern_idx` serves that
 * one; see both indexes' comments in
 * `src/db/schema.ts`. "Most recent" here is `id desc limit 1`, not `at desc` — `id` is
 * the serial primary key, so ordering by it matches insertion order without
 * relying on clock precision.
 */
export async function logAuditIfChanged(
  dbx: Dbx,
  entry: {
    actor: string;
    action: string;
    target: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  const [last] = await dbx
    .select({ details: auditLog.details })
    .from(auditLog)
    .where(and(eq(auditLog.action, entry.action), eq(auditLog.target, entry.target)))
    .orderBy(desc(auditLog.id))
    .limit(1);
  const unchanged =
    last !== undefined &&
    stableStringify(last.details ?? null) === stableStringify(entry.details ?? null);
  if (unchanged) return;
  await logAudit(dbx, entry);
}

export type ResolvedAuditRow = typeof auditLog.$inferSelect & {
  actorName: string | null;
  actorKind: "system" | "account" | "unresolved";
  targetName: string | null;
  targetKind: TargetKind | "literal" | "unresolved";
  /** Account uuids embedded in `details` (not the row's own actor/target),
   * resolved to their main character's name the same way actor/target are.
   * Keyed by the `details` field name so `summarizeDetails` can look one up
   * without knowing which action wrote it. Empty for every row that carries
   * no such field — see `DETAIL_ACCOUNT_KEYS`. */
  detailAccountNames: Record<string, string>;
  /** Character ids embedded in `details`, resolved to that character's name —
   * see `DETAIL_CHARACTER_KEYS`. Keyed by the `details` field name rather than
   * by the id: `access_list.holder_replaced` carries two different character
   * ids on the same row (`characterId` and `previousCharacterId`), and an
   * id-keyed map could not tell a caller which field either name came from. */
  detailCharacterNames: Record<string, string>;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS_RE = /^\d+$/;

/**
 * The literal, non-id values the audit log stores: `system` as an actor (every
 * job writes it), `all` as the broadcast target of `sync.requested` /
 * `sync.recheck_requested`, and a job type as the target of a single-job
 * `sync.requested` (src/app/admin/sync/actions.ts).
 *
 * The job types are DERIVED from the schedules table rather than listed here,
 * because that table is what the re-run action validates against
 * (`isJobType`): a new scheduled job becomes a filterable target the same day
 * it becomes re-runnable, with no second list to forget. A hand-written list is
 * exactly how the `"all"`-only assumption this replaces went stale.
 *
 * These bypass name resolution in both directions — they must render as
 * `literal` (a clickable filter link on the audit page) and short-circuit as a
 * raw filter value, or filtering by them matches no character and silently
 * returns nothing.
 *
 * Reserving a string costs something: a *character* named exactly like one of
 * these can no longer be found by name, because the literal check wins before
 * any name lookup happens. So the reservation is no wider than the column it
 * is needed in. Job types are only ever written to `target` (by `sync.*`), so
 * reserving them for `actor` too would buy nothing while shadowing whatever
 * an account or character might legitimately be called there. `system` and
 * `all` stay field-agnostic: that predates this change, and narrowing them now
 * would be an unrelated behaviour change.
 */
const RESERVED_LITERALS_ANY_FIELD: ReadonlySet<string> = new Set(["system", "all"]);

/**
 * Every literal reserved *in the target column* — the union, not the
 * job-types-only remainder its name might suggest. `system` is in here by
 * inheritance and that is load-bearing, not incidental: `logAudit` writes
 * `actor: "system"` from every job, and nothing stops a future call site
 * writing `target: "system"` for a system-owned object. Were it absent, such a
 * row would fall through to name resolution, resolve to nothing, and render as
 * `unresolved` — a dead cell instead of a filter link.
 */
const RESERVED_TARGET_LITERALS: ReadonlySet<string> = new Set([
  ...RESERVED_LITERALS_ANY_FIELD,
  ...Object.keys(JOB_CRON),
]);

type TargetKind = "account" | "character" | "discord" | "payout";

/**
 * Every target is written by exactly one call site shape in this codebase
 * (grep `logAudit(` across src/), so the *action* namespace is a reliable,
 * intentional signal for what a target string means — unlike its shape. An
 * EVE character id and a Discord snowflake are both bare digit strings, so
 * shape alone (or a magnitude heuristic, since snowflakes are ~18-19 digits
 * and character ids are ~9-10) would work only by coincidence today and
 * silently rot the day either numbering scheme changes.
 *
 * This is the single source of truth for the app's action-namespace
 * vocabulary: `ACTION_NAMESPACES` (below, for the `/admin/audit` filter UI)
 * and `targetKindFromAction` both derive from it, so a namespace can only be
 * added or reclassified in one place. The literal targets of `sync.*`
 * (`"all"`, or a job type for a single-job re-run — see
 * RESERVED_TARGET_LITERALS) are short-circuited by the caller before
 * `targetKindFromAction` is consulted, so `sync.*` reaching it always means
 * the account-uuid form.
 *
 * `access_list.*` is the one namespace that breaks the "one shape per
 * namespace" premise above: `holder_designated`/`holder_replaced` target a
 * character id, but `watch_added`/`watch_removed` target an access-list id —
 * a kind `TargetKind` has no member for. Classified as `character` anyway,
 * because the holder actions are the ones worth resolving to a name and the
 * watch actions' ids are small (list ids in the hundreds of thousands vs.
 * ~9-10-digit character ids), so a false character match is not realistic in
 * practice; on the rare miss it just stays unresolved, exactly as it did
 * before this namespace existed. `access_list.watch_*`'s target is rendered
 * from its own `details` payload (`summarize.ts`'s `accessListRef`), not from
 * this resolution, so nothing user-facing depends on the id being "right"
 * here.
 */
const NAMESPACE_TARGET_KIND = {
  "access_list.": "character",
  "account.": "account",
  "admin.": "account",
  "character.": "character",
  "discord.": "discord",
  "payout.": "payout",
  "status.": "account",
  "sync.": "account",
  "tier.": "account",
  "token.": "character",
  "wanderer.": "character",
} as const satisfies Record<`${string}.`, TargetKind>;

type ActionNamespace = keyof typeof NAMESPACE_TARGET_KIND;

/** Ordered (alphabetically — this is rendered to a human as a `<datalist>`)
 * list of every action namespace prefix, trailing dot included. Derived from
 * `NAMESPACE_TARGET_KIND` above, so it cannot drift from that mapping.
 *
 * Exported for the `/admin/audit` filter UI, but note it is load-bearing for
 * classification too: `targetKindFromAction` iterates this array rather than
 * re-reading the map's keys, which is what makes it impossible for the
 * vocabulary offered to an admin and the vocabulary the classifier recognizes
 * to disagree about membership. The `Object.keys` cast is the one TypeScript
 * forces — it returns `string[]` for every object, however narrow the keys. */
export const ACTION_NAMESPACES: readonly ActionNamespace[] = (
  Object.keys(NAMESPACE_TARGET_KIND) as ActionNamespace[]
).sort();

function targetKindFromAction(action: string): TargetKind | null {
  for (const namespace of ACTION_NAMESPACES) {
    if (action.startsWith(namespace)) return NAMESPACE_TARGET_KIND[namespace];
  }
  return null;
}

/**
 * `details` keys that hold an account uuid, per action, resolved through the
 * same account-and-character join actor/target use. `character.reclaimed`'s
 * `fromAccount` is the one case in the repo today (services/accounts.ts):
 * unlike `account.merged`'s `sourceAccountId`, the account this points to is
 * NOT deleted by the write that logs it -- only the one character is -- so it
 * stays resolvable for as long as the account exists, and reading its full
 * uuid off the Details column (summarize.ts previously rendered it with
 * `labelled`, verbatim) was pure recitation with no reason for it. Add a row
 * here, not a hardcoded field name, so a future action gets the same
 * treatment by declaring its key rather than by another pass through this
 * file.
 */
const DETAIL_ACCOUNT_KEYS: Readonly<Record<string, readonly string[]>> = {
  "character.reclaimed": ["fromAccount"],
};

/**
 * `details` keys that hold a character id, per action — same idea as
 * `DETAIL_ACCOUNT_KEYS`, one join fewer. These ids name a character this app
 * had a row for at write time, but a character row is HARD-deleted the moment
 * it is unlinked or reclaimed (accounts.ts, both the reclaim and unlink
 * paths), so resolution here is best-effort: the renderer falls back to the
 * raw id, same as any other unresolved detail.
 *
 * `access_list.watch_added`/`watch_removed`'s `accessListId` is deliberately
 * NOT listed here — it is an EVE access-list id, not a character id, and is
 * exactly the false-positive a bare key-name heuristic would produce (see the
 * `NAMESPACE_TARGET_KIND` comment above, which flags this same namespace for
 * the same reason on the target column).
 *
 * `token.subject_mismatch`'s `subjectCharacterId` is, by construction, a
 * DIFFERENT character from the row's own target (src/jobs/token-health.ts):
 * it names whichever character the mismatched token actually belongs to, so
 * it will often belong to a still-live character on someone else's account
 * and resolve fine, but on occasion belongs to one already gone — that is
 * expected, not a bug.
 */
const DETAIL_CHARACTER_KEYS: Readonly<Record<string, readonly string[]>> = {
  "account.created": ["mainCharacterId"],
  "account.main_changed": ["mainCharacterId"],
  "admin.main_changed": ["mainCharacterId"],
  "account.merged": ["characterId"],
  "admin.bootstrap_granted": ["characterId"],
  "access_list.holder_designated": ["characterId"],
  "access_list.holder_replaced": ["characterId", "previousCharacterId"],
  "token.subject_mismatch": ["subjectCharacterId"],
};

/**
 * `jsonb` gives back a genuine number for anything written as one, but the
 * column's shape is unenforced by the type system — a hand-inserted or
 * legacy row could hold the same id as a digit string instead. Accept either
 * and reject everything else, rather than assuming today's writer shape is
 * the only one that will ever be read.
 */
function detailCharacterId(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isInteger(raw) ? raw : null;
  if (typeof raw === "string" && DIGITS_RE.test(raw)) return Number(raw);
  return null;
}

/**
 * Resolves actor/target ids to human (main character) names in a fixed,
 * small number of batched queries, independent of row count:
 *   1. accounts referenced directly (as actor or an account-shaped target)
 *      + discord links referenced as a target + payout operations referenced
 *      as a target, all in parallel
 *   2. accounts reached only via a discord link (to get *their*
 *      mainCharacterId) — skipped entirely if no discord targets resolved
 *   2b. names of deleted payout operations, recovered from the `payout.deleted`
 *      audit row's own details — skipped entirely if step 1 resolved every
 *      payout target already
 *   3. every character name needed (target characters + all main characters
 *      collected above), in one shot
 * Anything that doesn't resolve is left as `null`/`"unresolved"`; the raw
 * `actor`/`target` strings on the row are always preserved unchanged.
 */
export async function resolveAuditIdentities(
  dbx: Dbx,
  rows: Array<typeof auditLog.$inferSelect>,
): Promise<ResolvedAuditRow[]> {
  if (rows.length === 0) return [];

  const accountIds = new Set<string>();
  const targetCharacterIds = new Set<number>();
  const targetDiscordIds = new Set<string>();
  const targetPayoutIds = new Set<string>();
  const detailCharacterIds = new Set<number>();

  for (const r of rows) {
    if (r.actor !== "system" && UUID_RE.test(r.actor)) accountIds.add(r.actor);
    if (!RESERVED_TARGET_LITERALS.has(r.target)) {
      const kind = targetKindFromAction(r.action);
      if (kind === "account" && UUID_RE.test(r.target)) accountIds.add(r.target);
      else if (kind === "character" && DIGITS_RE.test(r.target))
        targetCharacterIds.add(Number(r.target));
      else if (kind === "discord" && DIGITS_RE.test(r.target))
        targetDiscordIds.add(r.target);
      else if (kind === "payout" && UUID_RE.test(r.target)) targetPayoutIds.add(r.target);
    }
    // Same join, a different source: an account uuid living inside `details`
    // rather than in the target/actor columns themselves. Folded into the
    // same `accountIds` set so it costs nothing beyond the (already
    // in-flight) account query gaining one more id to look up.
    for (const key of DETAIL_ACCOUNT_KEYS[r.action] ?? []) {
      const raw = r.details?.[key];
      if (typeof raw === "string" && UUID_RE.test(raw)) accountIds.add(raw);
    }
    // Same idea, one join fewer: a character id living inside `details`,
    // folded into the same `characterIds` set seeded below so it rides the
    // already in-flight `character` query rather than paying for a new one.
    for (const key of DETAIL_CHARACTER_KEYS[r.action] ?? []) {
      const id = detailCharacterId(r.details?.[key]);
      if (id !== null) detailCharacterIds.add(id);
    }
  }

  const [directAccounts, links, payoutOperations] = await Promise.all([
    accountIds.size
      ? dbx
          .select({ id: account.id, mainCharacterId: account.mainCharacterId })
          .from(account)
          .where(inArray(account.id, [...accountIds]))
      : Promise.resolve([]),
    targetDiscordIds.size
      ? dbx
          .select({
            accountId: discordLink.accountId,
            discordUserId: discordLink.discordUserId,
          })
          .from(discordLink)
          .where(inArray(discordLink.discordUserId, [...targetDiscordIds]))
      : Promise.resolve([]),
    targetPayoutIds.size
      ? dbx
          .select({ id: payoutOperation.id, name: payoutOperation.name })
          .from(payoutOperation)
          .where(inArray(payoutOperation.id, [...targetPayoutIds]))
      : Promise.resolve([]),
  ]);

  const accountById = new Map(directAccounts.map((a) => [a.id, a]));
  const discordAccountIds = links
    .map((l) => l.accountId)
    .filter((id) => !accountById.has(id));
  const discordAccounts = discordAccountIds.length
    ? await dbx
        .select({ id: account.id, mainCharacterId: account.mainCharacterId })
        .from(account)
        .where(inArray(account.id, discordAccountIds))
    : [];
  for (const a of discordAccounts) accountById.set(a.id, a);

  const discordUserToAccountId = new Map(
    links.map((l) => [l.discordUserId, l.accountId]),
  );
  const nameByPayoutId = new Map(payoutOperations.map((o) => [o.id, o.name]));

  // The live join above misses every deleted operation, and a delete is a
  // hard delete (schema.ts: every payout child table cascades, so there is no
  // tombstone row to join against). Without this, EVERY historical row for
  // that operation -- payout.created, payout.paid, payout.reverted, not just
  // payout.deleted itself -- would resolve to null and lose its clickable
  // filter link. The name survives because `deleteOperation` denormalises it
  // onto its own audit row before the operation disappears; this is that
  // fallback read. One extra query, skipped entirely when nothing missed.
  const missedPayoutIds = [...targetPayoutIds].filter((id) => !nameByPayoutId.has(id));
  if (missedPayoutIds.length > 0) {
    const deletions = await dbx
      .select({ target: auditLog.target, details: auditLog.details })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "payout.deleted"),
          inArray(auditLog.target, missedPayoutIds),
        ),
      );
    for (const row of deletions) {
      const name = row.details?.name;
      if (typeof name === "string") nameByPayoutId.set(row.target, name);
    }
  }

  const characterIds = new Set<number>([...targetCharacterIds, ...detailCharacterIds]);
  for (const a of accountById.values()) {
    if (a.mainCharacterId !== null) characterIds.add(a.mainCharacterId);
  }
  const characters = characterIds.size
    ? await dbx
        .select({ id: character.id, name: character.name })
        .from(character)
        .where(inArray(character.id, [...characterIds]))
    : [];
  const nameByCharacterId = new Map(characters.map((c) => [c.id, c.name]));

  const mainNameOf = (accountId: string): string | null => {
    const acc = accountById.get(accountId);
    if (!acc || acc.mainCharacterId === null) return null;
    return nameByCharacterId.get(acc.mainCharacterId) ?? null;
  };

  return rows.map((r) => {
    let actorName: string | null = null;
    let actorKind: ResolvedAuditRow["actorKind"] = "unresolved";
    if (r.actor === "system") {
      actorKind = "system";
    } else if (UUID_RE.test(r.actor)) {
      const name = mainNameOf(r.actor);
      if (name !== null) {
        actorName = name;
        actorKind = "account";
      }
    }

    let targetName: string | null = null;
    let targetKind: ResolvedAuditRow["targetKind"] = "unresolved";
    if (RESERVED_TARGET_LITERALS.has(r.target)) {
      // Renders as a filter link (see TargetCell): a single-job sync re-run
      // names its job here, and a target you cannot click to filter by is
      // half the value of recording it.
      targetKind = "literal";
    } else {
      const kind = targetKindFromAction(r.action);
      if (kind === "account" && UUID_RE.test(r.target)) {
        const name = mainNameOf(r.target);
        if (name !== null) {
          targetName = name;
          targetKind = "account";
        }
      } else if (kind === "character" && DIGITS_RE.test(r.target)) {
        const name = nameByCharacterId.get(Number(r.target)) ?? null;
        if (name !== null) {
          targetName = name;
          targetKind = "character";
        }
      } else if (kind === "discord" && DIGITS_RE.test(r.target)) {
        const accId = discordUserToAccountId.get(r.target);
        const name = accId !== undefined ? mainNameOf(accId) : null;
        if (name !== null) {
          targetName = name;
          targetKind = "discord";
        }
      } else if (kind === "payout" && UUID_RE.test(r.target)) {
        const name = nameByPayoutId.get(r.target) ?? null;
        if (name !== null) {
          targetName = name;
          targetKind = "payout";
        }
      }
    }

    // Same lookup as actor/target, run per declared key rather than per
    // field name so a row with none of these keys (nearly every row) does
    // no work beyond an empty-array `??` check.
    const detailAccountNames: Record<string, string> = {};
    for (const key of DETAIL_ACCOUNT_KEYS[r.action] ?? []) {
      const raw = r.details?.[key];
      const name = typeof raw === "string" ? mainNameOf(raw) : null;
      if (name !== null) detailAccountNames[key] = name;
    }

    const detailCharacterNames: Record<string, string> = {};
    for (const key of DETAIL_CHARACTER_KEYS[r.action] ?? []) {
      const id = detailCharacterId(r.details?.[key]);
      const name = id !== null ? (nameByCharacterId.get(id) ?? null) : null;
      if (name !== null) detailCharacterNames[key] = name;
    }

    return {
      ...r,
      actorName,
      actorKind,
      targetName,
      targetKind,
      detailAccountNames,
      detailCharacterNames,
    };
  });
}

export type FilterResolution =
  | { kind: "raw"; ids: string[] }
  | {
      kind: "name";
      name: string;
      ids: string[];
      accountCount: number;
      operationCount: number;
    }
  | { kind: "none"; name: string };

/**
 * Inverts `resolveAuditIdentities` for the filter box: turns what an admin
 * sees ("Zed", "Thursday roam") back into the raw ids the audit log actually
 * stores.
 *
 * A raw id costs nothing -- UUIDs, bare digit strings and the reserved
 * literals short-circuit with zero queries, which is what keeps pasting an id
 * working. Everything else is a name, resolved along the display paths
 * `resolveAuditIdentities` renders:
 *
 *   actor  -> accounts whose main character carries the name (actor is only
 *             ever an account uuid or "system", so nothing else can match)
 *   target -> those accounts, PLUS every character carrying the name, PLUS the
 *             discord ids linked to those accounts, PLUS every payout
 *             operation carrying the name (live or deleted) -- one name can
 *             legitimately mean a person AND an unrelated operation, and a
 *             filter that pinned one would silently hide the other
 *
 * Deliberately NOT called from inside queryAuditLog: that function receives
 * raw ids only, so a caller passing a non-uuid raw actor (as
 * tests/audit-query.test.ts does) can never have it reinterpreted as a name.
 */
export async function resolveFilterIdentity(
  dbx: Dbx,
  field: "actor" | "target",
  value: string,
): Promise<FilterResolution> {
  const reserved =
    field === "target" ? RESERVED_TARGET_LITERALS : RESERVED_LITERALS_ANY_FIELD;
  if (reserved.has(value) || UUID_RE.test(value) || DIGITS_RE.test(value)) {
    return { kind: "raw", ids: [value] };
  }

  if (field === "actor") {
    // An operation name can never appear in the actor column: every logAudit
    // call site in src/ passes an account uuid or the literal "system" as
    // `actor`, and schema.ts documents the column as exactly that. An
    // operation uuid only ever reaches `target`. So there is no payout lookup
    // to run here -- an actor filter costs exactly what it always did.
    const chars = await dbx
      .select({ id: character.id, accountId: character.accountId })
      .from(character)
      .where(sql`lower(${character.name}) = lower(${value})`);
    if (chars.length === 0) return { kind: "none", name: value };

    const characterIds = chars.map((c) => c.id);
    const mains = await dbx
      .select({ id: account.id })
      .from(account)
      .where(inArray(account.mainCharacterId, characterIds));
    const displayAccountIds = mains.map((a) => a.id);

    // An alt's name can never appear in the actor column, so its owning
    // account neither contributes rows nor counts toward ambiguity.
    if (displayAccountIds.length === 0) return { kind: "none", name: value };
    return {
      kind: "name",
      name: value,
      ids: displayAccountIds,
      accountCount: displayAccountIds.length,
      operationCount: 0,
    };
  }

  // target: characters and payout operations are independent lookups, so run
  // all three in one round rather than paying for the character query (and
  // deciding "none" from it alone) before an operation match is even checked
  // -- that ordering is exactly the bug this replaces.
  const [chars, liveOps, deletedOps] = await Promise.all([
    // every character carrying the name (case-insensitive), with its owner
    dbx
      .select({ id: character.id, accountId: character.accountId })
      .from(character)
      .where(sql`lower(${character.name}) = lower(${value})`),
    // live operations carrying the name
    dbx
      .select({ id: payoutOperation.id })
      .from(payoutOperation)
      .where(sql`lower(${payoutOperation.name}) = lower(${value})`),
    // deleted operations, recovered from their own payout.deleted audit row --
    // a delete is a hard delete (every payout child table cascades, schema.ts),
    // so there is no tombstone to join against; `deleteOperation`
    // (src/services/payouts.ts) reads the name off the operation and writes it
    // into that audit row's details, both inside the transaction that drops
    // the row. Unlike the equivalent fallback in resolveAuditIdentities, this
    // is NOT gated on the live query missing anything: a deleted operation can
    // share a name with a live one and is still a distinct operation the
    // filter must include, not a redundant lookup to skip.
    dbx
      .select({ target: auditLog.target })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "payout.deleted"),
          sql`lower((${auditLog.details})->>'name') = lower(${value})`,
        ),
      ),
  ]);

  const operationIds = new Set<string>([
    ...liveOps.map((o) => o.id),
    ...deletedOps.map((o) => o.target),
  ]);

  if (chars.length === 0 && operationIds.size === 0) {
    return { kind: "none", name: value };
  }

  const characterIds = chars.map((c) => c.id);

  // the accounts that *display* the name, i.e. whose main is one of those
  const mains = characterIds.length
    ? await dbx
        .select({ id: account.id })
        .from(account)
        .where(inArray(account.mainCharacterId, characterIds))
    : [];
  const displayAccountIds = mains.map((a) => a.id);

  // discord ids of the displaying accounts (this one IS index-backed --
  // discord_link.account_id is that table's primary key)
  const links = displayAccountIds.length
    ? await dbx
        .select({ discordUserId: discordLink.discordUserId })
        .from(discordLink)
        .where(inArray(discordLink.accountId, displayAccountIds))
    : [];

  const ids = [
    ...displayAccountIds,
    ...characterIds.map(String),
    ...links.map((l) => l.discordUserId),
    ...operationIds,
  ];

  // Matched character ids are in the union, so their owning accounts are
  // surfaced too and must count -- otherwise two same-named alts on two
  // accounts widen the results while the page reports no ambiguity.
  const accountCount = new Set([...displayAccountIds, ...chars.map((c) => c.accountId)])
    .size;

  return {
    kind: "name",
    name: value,
    ids,
    accountCount,
    operationCount: operationIds.size,
  };
}

export async function queryAuditLog(
  dbx: Dbx,
  filters: {
    /** Raw actor ids. Exactly one -> equality; several -> any-of; empty -> no
     * rows. Names are resolved by resolveFilterIdentity BEFORE this call, so a
     * non-uuid raw actor can never be mistaken for one. */
    actorIds?: string[];
    action?: string; // prefix match, e.g. "tier."
    /** Raw target ids; one person spans several (see resolveFilterIdentity). */
    targetIds?: string[];
    beforeId?: number;
    limit?: number;
  } = {},
): Promise<ResolvedAuditRow[]> {
  // An empty list is "resolved to nothing", not "unfiltered" -- short-circuit
  // rather than let it degrade into a full scan.
  if (filters.actorIds?.length === 0 || filters.targetIds?.length === 0) return [];

  const conds = [];
  if (filters.actorIds) {
    conds.push(
      filters.actorIds.length === 1
        ? eq(auditLog.actor, filters.actorIds[0])
        : inArray(auditLog.actor, filters.actorIds),
    );
  }
  if (filters.action) {
    // The filter is a LITERAL prefix; % and _ are LIKE wildcards, so escape
    // them (and backslash, Postgres's default escape character).
    const prefix = filters.action.replace(/[\\%_]/g, (c) => `\\${c}`);
    conds.push(like(auditLog.action, `${prefix}%`));
  }
  if (filters.targetIds) {
    conds.push(
      filters.targetIds.length === 1
        ? eq(auditLog.target, filters.targetIds[0])
        : inArray(auditLog.target, filters.targetIds),
    );
  }
  if (filters.beforeId !== undefined) conds.push(lt(auditLog.id, filters.beforeId));
  const limit = Math.min(filters.limit ?? AUDIT_PAGE_SIZE, AUDIT_PAGE_SIZE);
  const rows = await dbx
    .select()
    .from(auditLog)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(auditLog.id))
    .limit(limit);
  return resolveAuditIdentities(dbx, rows);
}
