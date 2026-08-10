import type { Tone } from "@/app/_components/ui";
import type { AccessListReadStatus } from "@/db/schema";
import { ACCESS_LISTS_SCOPE } from "@/lib/esi/client";

/**
 * The pure decisions behind `/admin/access-lists`, split from `page.tsx` for
 * the same reason `admin/sync/view.ts` is: the seven states this page has to
 * distinguish are a priority-ordered cascade, and the only way to exercise a
 * cascade living inside a server component is to seed a database and drive a
 * browser. Three of the seven (the dark-monitor states) are the ones most
 * likely to be reached in production and the least likely to be reached by
 * hand in review, which is precisely the shape that wants a cheap test each.
 */

export type HolderRef = { characterId: number; name: string };

export type MonitorInput = {
  /** The designated holder, joined to its character row, or null. */
  holder: {
    characterId: number;
    name: string;
    scopes: string[];
    tokenStatus: "valid" | "invalid" | "needs_reauth" | "missing";
  } | null;
  /** Whether the *viewing admin's* main character already granted the scope —
   *  what decides between "Grant access" and "Designate as holder". */
  viewerHasScope: boolean;
  catalogSize: number;
};

export type MonitorState =
  | { kind: "grant-needed" }
  | { kind: "designate-needed" }
  | { kind: "scope-dropped"; holder: HolderRef }
  | { kind: "holder-needs-reauth"; holder: HolderRef }
  | { kind: "holder-no-token"; holder: HolderRef; tokenStatus: "invalid" | "missing" }
  | { kind: "catalog-empty"; holder: HolderRef }
  | { kind: "normal"; holder: HolderRef };

/**
 * The cascade, in the spec's priority order. Order is the whole content of
 * this function, so it is worth saying what each precedence buys:
 *
 * The scope check precedes the token check because the two faults are not
 * independent — a holder that re-authenticated through the ordinary link has
 * a perfectly `valid` token AND no ACL scope, and the plain re-auth link this
 * page would offer for a token fault is the exact action that dropped the
 * scope. Offering it first would send an admin round the loop that caused the
 * problem. When both are wrong, the granting link fixes both at once.
 *
 * The catalog check comes last of the faults because an empty catalog under a
 * healthy holder is not a fault at all: it is a holder the job has not run for
 * yet, and its one remedy is the button that runs it.
 */
export function monitorState(input: MonitorInput): MonitorState {
  const { holder, viewerHasScope, catalogSize } = input;
  if (holder === null) {
    return viewerHasScope ? { kind: "designate-needed" } : { kind: "grant-needed" };
  }
  const ref: HolderRef = { characterId: holder.characterId, name: holder.name };
  if (!holder.scopes.includes(ACCESS_LISTS_SCOPE)) {
    return { kind: "scope-dropped", holder: ref };
  }
  if (holder.tokenStatus === "needs_reauth") {
    return { kind: "holder-needs-reauth", holder: ref };
  }
  if (holder.tokenStatus === "invalid" || holder.tokenStatus === "missing") {
    return { kind: "holder-no-token", holder: ref, tokenStatus: holder.tokenStatus };
  }
  if (catalogSize === 0) return { kind: "catalog-empty", holder: ref };
  return { kind: "normal", holder: ref };
}

/**
 * The one sentence above the fold. Each dark-monitor state names the holder,
 * says plainly that nothing is being read, and states the fault — the single
 * holder makes these the likeliest way the feature dies quietly, and a page
 * that renders zero rows without saying why is indistinguishable from a page
 * saying everything is fine.
 */
export function monitorSentence(state: MonitorState): string {
  switch (state.kind) {
    case "grant-needed":
      return (
        "This page compares the alliance roster against the in-game access lists. " +
        "Nobody has granted the access-list scope yet, so nothing can be read."
      );
    case "designate-needed":
      return (
        "Your character has granted the access-list scope. Designate it as the " +
        "holder to start reading lists."
      );
    case "scope-dropped":
      return (
        `${state.holder.name} is the holder, but no longer carries the access-list ` +
        "scope — an ordinary re-authentication drops it, so no reads are happening."
      );
    case "holder-needs-reauth":
      return (
        `${state.holder.name} is the holder, and its authorization has gone stale. ` +
        "No reads are happening until it re-authenticates."
      );
    case "holder-no-token":
      return state.tokenStatus === "missing"
        ? `${state.holder.name} is the holder, but there is no stored token for it at ` +
            "all. No reads are happening."
        : `${state.holder.name} is the holder, and its stored token stopped working. ` +
            "No reads are happening.";
    case "catalog-empty":
      return `${state.holder.name} is the holder. No lists have been discovered yet.`;
    case "normal":
      return `${state.holder.name} is the holder.`;
  }
}

export type Remedy =
  | { kind: "link"; label: string; href: string }
  | { kind: "designate" }
  | { kind: "check-now" };

const GRANT_HREF = "/auth/eve/link?grant=access-lists";

/**
 * The one action that fixes the state. A total function over the union rather
 * than a `Record`, because two members vary their remedy by a second field and
 * a `Record` keyed on `kind` alone could not express that — but still
 * exhaustive, so a new state is a compile error here rather than a state
 * rendering with no way out of it.
 *
 * `scope-dropped` and `grant-needed` share `GRANT_HREF`; the two token states
 * share the bare `/auth/eve/link`. That split is the load-bearing part: the
 * bare link is what drops the ACL scope in the first place, so it must never
 * be the remedy offered for a missing scope.
 */
export function monitorRemedy(state: MonitorState): Remedy {
  switch (state.kind) {
    case "grant-needed":
      return { kind: "link", label: "Grant access", href: GRANT_HREF };
    case "designate-needed":
      return { kind: "designate" };
    case "scope-dropped":
      return { kind: "link", label: "Re-grant access", href: GRANT_HREF };
    case "holder-needs-reauth":
      return { kind: "link", label: "Re-authenticate", href: "/auth/eve/link" };
    case "holder-no-token":
      return { kind: "link", label: "Add this character again", href: "/auth/eve/link" };
    case "catalog-empty":
    case "normal":
      return { kind: "check-now" };
  }
}

/**
 * Whether the watched-list table renders under the problem sentence. True for
 * every state that has a holder: a stale answer with its age beats a blank
 * page, and the age is what tells the admin how long the monitor has been
 * dark. False only when no holder was ever designated, where there is nothing
 * to be stale about.
 */
export function showsObservations(state: MonitorState): boolean {
  return state.kind !== "grant-needed" && state.kind !== "designate-needed";
}

/**
 * The one corporation shared by every member missing access, or null when they
 * do not share one.
 *
 * Same shape and same argument as `crewNorms` in `src/app/account/page.tsx`:
 * the Corporation column exists to tell rows apart, and on the common case —
 * one corp's members left off an alliance list — it tells them apart not at
 * all while charging every row for the repetition. Measure the norm against
 * the set, state it once above the list, and let the rows carry only what
 * differs.
 *
 * A single unknown corporation (`corporationId === null`) defeats the norm
 * rather than being folded into it. The sentence this feeds says "all of
 * them", and it has to be true of all of them; a row we cannot place is
 * exactly the row that sentence would be lying about.
 */
export function sharedCorporation(
  rows: { corporationId: number | null }[],
): number | null {
  const first = rows[0]?.corporationId ?? null;
  if (first === null) return null;
  return rows.every((r) => r.corporationId === first) ? first : null;
}

export type WatchedRow = {
  accessListId: number;
  name: string | null;
  /** null when the job has never attempted this list — no snapshot row. */
  readStatus: AccessListReadStatus | null;
  observedAt: Date | null;
  allowEveryone: boolean | null;
  missingAccess: number;
  nonMembers: number;
  broadGrants: number;
};

function drifted(row: WatchedRow): boolean {
  return row.missingAccess > 0 || row.nonMembers > 0;
}

/**
 * `bad` is not in this function's range, and that is a rule rather than an
 * omission: PRODUCT.md reserves the alarm colour for destructive acts, and
 * nothing this page reports is one — every row here is a read of a list only a
 * human can change in-game. Drift is `warn`, a failed read is `warn`, and a
 * list nobody has read yet is `off` for the same reason `sync/view.ts` gives
 * `never` that tone: it has not failed at anything.
 */
export function rowTone(row: WatchedRow): Tone {
  if (row.readStatus === null) return "off";
  if (row.readStatus !== "ok") return "warn";
  if (row.allowEveryone === true) return "warn";
  return drifted(row) ? "warn" : "ok";
}

/**
 * The words beside the tone, so colour is never the sole carrier. A read
 * failure preempts the drift counts rather than printing beside them: those
 * counts were computed from the last *successful* read, and stating them as
 * this row's current answer would date a stale number to now.
 *
 * `allow_everyone` gets its own wording rather than "in sync". Such a list has
 * zero missing members by construction, so the ordinary clean sentence would
 * read as "correctly configured" when it means "open to everyone".
 */
export function rowSummary(row: WatchedRow): string {
  if (row.readStatus === null) return "not read yet";
  if (row.readStatus === "not_visible") return "not visible to holder";
  if (row.readStatus === "failed") return "read failed";
  if (row.allowEveryone === true) return "open to everyone";
  const parts: string[] = [];
  if (row.missingAccess > 0) parts.push(`${row.missingAccess} missing access`);
  if (row.nonMembers > 0) {
    // Verb and noun agree with the count: "1 has access, not a member" but
    // "2 have access, not members".
    parts.push(
      row.nonMembers === 1
        ? "1 has access, not a member"
        : `${row.nonMembers} have access, not members`,
    );
  }
  return parts.length === 0 ? "in sync" : parts.join(" · ");
}

/**
 * Whether this row gets a disclosure control at all. A clean list is one line
 * with nothing to open — the common case on a page whose whole job is to be
 * boring — and a row with no detail behind a toggle is a control that promises
 * something and delivers an empty box.
 *
 * A never-read row has no detail either: there is no snapshot to describe.
 */
export function rowHasDetail(row: WatchedRow): boolean {
  if (row.readStatus === null) return false;
  if (row.readStatus !== "ok") return true;
  return row.allowEveryone === true || row.broadGrants > 0 || drifted(row);
}

/**
 * `HH:MM:SS.mmm UTC` for the enqueue instant in `?at=`, or null. Lifted
 * wholesale from `admin/sync/view.ts`'s `queuedStamp` and for its reasons:
 * the query string is untrusted input reaching copy, milliseconds are what let
 * a second press of the same button produce a different string, and the length
 * check catches the extended-year ISO form a hand-edited `?at=` reaches first.
 */
export function doneStamp(at: string | undefined): string | null {
  if (at === undefined || !/^\d{1,15}$/.test(at)) return null;
  const d = new Date(Number(at));
  if (Number.isNaN(d.getTime())) return null;
  const iso = d.toISOString();
  if (iso.length !== 24) return null;
  return `${iso.slice(11, 23)} UTC`;
}

/**
 * The outcome of the press that produced this render, for the three actions
 * that redirect. An unrecognized marker yields the empty string rather than
 * being echoed — `Notice` renders an empty slot for it, which is the shape
 * that keeps its live region announcing changes rather than being born full.
 */
export function doneNotice(done: string | undefined, at: string | undefined): string {
  const stamp = doneStamp(at);
  const when = stamp === null ? "" : ` at ${stamp}`;
  if (done === "holder") {
    return `Holder designated${when}. The next read will use it.`;
  }
  if (done === "watch") {
    return `List added to the watchlist${when}. It is read on the next run.`;
  }
  if (done === "check") {
    return `Check queued${when}. Reload this page once the worker has run.`;
  }
  return "";
}
