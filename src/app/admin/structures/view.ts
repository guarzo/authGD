import type { StructureReadStatus } from "@/db/schema";
import type { HolderView } from "@/services/structures";
import { NOTIFICATIONS_SCOPE, STRUCTURES_SCOPE } from "@/lib/esi/client";

export type MonitorState =
  | "grant-needed"
  | "designate-needed"
  | "scope-dropped"
  | "holder-needs-reauth"
  | "holder-no-token"
  | "corp-changed"
  | "no-corp-roles"
  | "roster-empty"
  | "alerts-unconfigured"
  | "normal";

export const GRANT_HREF = "/auth/eve/link?grant=structures";
const REAUTH_HREF = "/auth/eve/link";

// HolderView is declared in @/services/structures (Task 6) and imported above:
// it describes that service read's return shape, and re-declaring it here
// would give the two files a copy each to drift apart.

export type MonitorInput = {
  grantable: { characterId: number; name: string } | null;
  holder: HolderView | null;
  readStates: Partial<Record<"roster" | "events", { readStatus: StructureReadStatus }>>;
  rosterCount: number;
  webhookConfigured: boolean;
};

/**
 * A priority cascade, most blocking first. Total over its input: every arm
 * returns, so a new field cannot leave the page with no sentence to print.
 *
 * Scope BEFORE token, deliberately. A dropped grant and a stale token both
 * want an EVE round trip, but they want DIFFERENT ones: the bare re-auth link
 * is what drops the opt-in scope in the first place, so offering it to a
 * scope-dropped holder sends an admin round a loop that cannot terminate.
 *
 * corp-changed is derived HERE, live, rather than read from
 * structure_read_state.detail — the page must say so the moment affiliation
 * updates, not up to an hour later when the roster job next ticks.
 */
export function monitorState(input: MonitorInput): MonitorState {
  const { holder } = input;
  if (!holder) return input.grantable ? "designate-needed" : "grant-needed";
  const hasScopes =
    holder.scopes.includes(STRUCTURES_SCOPE) &&
    holder.scopes.includes(NOTIFICATIONS_SCOPE);
  if (!hasScopes) return "scope-dropped";
  if (holder.tokenStatus === "needs_reauth") return "holder-needs-reauth";
  if (holder.tokenStatus === "missing" || holder.tokenStatus === "invalid") {
    return "holder-no-token";
  }
  if (
    holder.currentCorporationId !== null &&
    holder.currentCorporationId !== holder.corporationId
  ) {
    return "corp-changed";
  }
  if (forbiddenReads(input).length > 0) return "no-corp-roles";
  if (input.rosterCount === 0) return "roster-empty";
  if (!input.webhookConfigured) return "alerts-unconfigured";
  return "normal";
}

/** Which of the two reads the corp refused. Both can be forbidden at once. */
export function forbiddenReads(input: MonitorInput): ("roster" | "events")[] {
  const out: ("roster" | "events")[] = [];
  if (input.readStates.roster?.readStatus === "forbidden") out.push("roster");
  if (input.readStates.events?.readStatus === "forbidden") out.push("events");
  return out;
}

const READ_LABEL: Record<"roster" | "events", string> = {
  roster: "structure list",
  events: "notifications",
};

export function monitorSentence(
  state: MonitorState,
  ctx: { name?: string; count?: number; forbidden?: ("roster" | "events")[] },
): string {
  const who = ctx.name ?? "The holder";
  switch (state) {
    case "grant-needed":
      return "No character has granted structure access.";
    case "designate-needed":
      return `${who} granted structure access but is not the holder.`;
    case "scope-dropped":
      return `${who} is the holder but no longer grants structure access.`;
    case "holder-needs-reauth":
      return `${who} needs to sign in to EVE again.`;
    case "holder-no-token":
      return `${who} has no usable EVE token.`;
    case "corp-changed":
      return `${who} has left the corporation this roster belongs to.`;
    case "no-corp-roles":
      return `The corporation refused the ${(ctx.forbidden ?? [])
        .map((k) => READ_LABEL[k])
        .join(" and ")} read.`;
    case "roster-empty":
      return "Nothing read yet.";
    case "alerts-unconfigured":
      return `${ctx.count ?? 0} structures. No Discord webhook is set, so nothing is alerted.`;
    case "normal":
      return `${ctx.count ?? 0} structures. Alerts go to Discord.`;
  }
}

export type Remedy = { href: string; label: string };

/**
 * Total exhaustive switch, no `default` arm: adding a MonitorState without
 * deciding its remedy must be a compile error, not a silent null.
 *
 * Three states return null because there is nothing this app can offer. The
 * corp-role grants and the webhook secret are both outside it — a button that
 * cannot fix the problem is worse than a sentence that explains it.
 */
export function monitorRemedy(state: MonitorState): Remedy | null {
  switch (state) {
    case "grant-needed":
      return { href: GRANT_HREF, label: "Grant structure access" };
    case "scope-dropped":
      return { href: GRANT_HREF, label: "Re-grant structure access" };
    case "holder-needs-reauth":
    case "holder-no-token":
      return { href: REAUTH_HREF, label: "Re-authenticate" };
    case "designate-needed":
    case "corp-changed":
    case "no-corp-roles":
    case "roster-empty":
    case "alerts-unconfigured":
    case "normal":
      return null;
  }
}

/** The roster is worth rendering in every state that has one. */
export function showsRoster(state: MonitorState): boolean {
  return (
    state === "normal" ||
    state === "alerts-unconfigured" ||
    state === "no-corp-roles" ||
    state === "corp-changed"
  );
}

/**
 * PRODUCT.md principle 4 reserves alarm colour for what a user can and should
 * fix. access-lists/view.ts:220-227 refuses `bad` on that basis; a structure in
 * hull or armor reinforce is precisely the exception it carves room for — a
 * fight you can still show up to.
 */
export function rowTone(state: string): "bad" | "warn" | "neutral" {
  if (state === "hull_reinforce" || state === "armor_reinforce") return "bad";
  if (state.endsWith("_vulnerable")) return "warn";
  return "neutral";
}

export function doneStamp(at: string | undefined): string | null {
  if (at === undefined || !/^\d{1,15}$/.test(at)) return null;
  const d = new Date(Number(at));
  if (Number.isNaN(d.getTime())) return null;
  const iso = d.toISOString();
  if (iso.length !== 24) return null;
  return `${iso.slice(11, 23)} UTC`;
}

/**
 * The outcome of the press that produced this render, for the two actions
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
  if (done === "check") {
    return `Check queued${when}. Reload this page once the worker has run.`;
  }
  return "";
}
