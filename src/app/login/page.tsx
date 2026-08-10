import type { Metadata } from "next";
import { Fragment } from "react";
import { Notice } from "@/app/_components/ui";
import { getConfig } from "@/config";
import { LOGIN_ERRORS, loginErrorTone, lookupErrorMessage } from "@/lib/error-redirects";

/**
 * What each ESI scope actually buys, in the reader's terms, for the one
 * moment this page exists to support: deciding whether to grant it. Grounded
 * in the real call sites rather than paraphrased from the identifier —
 * `esi-characters.write_contacts.v1` reads as "manage contacts" until you
 * check `src/jobs/contacts.ts` and see it also *deletes* them, which is the
 * kind of gap that makes a raw identifier the more honest choice than a
 * softened one.
 *
 * Keyed by the identifier so a fork's own `EVE_SSO_SCOPES` addition falls
 * through cleanly. The fallback says only what is true — that this map does
 * not describe the scope — rather than inventing a sentence it cannot back.
 * It is a real sentence rather than `undefined` because the caller renders a
 * `<dl>`: a `<dt>` with no `<dd>` is invalid there, and worse than invalid on
 * a consent screen, since AT groups a term with the next definition it finds
 * and would read an undescribed scope as meaning whatever the scope BELOW it
 * means. On the one page whose job is to say what is being granted, an
 * unknown scope wearing its neighbour's description is the failure worth
 * spending a line of copy to avoid.
 *
 * Each sentence now says only what distinguishes its scope from its
 * neighbours; whatever the whole group has in common is stated once, in the
 * group's own head (`SCOPE_GROUPS`). That is `crewNorms`' shape from
 * `account/page.tsx`, and the reason is the same: six sentences that each
 * re-established "so authGD can show your location" taught the reader that
 * these lines do not differ, on the one screen where the differences are the
 * entire point.
 */
function describeScope(scope: string, contactLabel: string): string {
  switch (scope) {
    // src/jobs/contacts.ts:14 — CONTACT_SCOPES[0]. getAllContacts() only.
    case "esi-characters.read_contacts.v1":
      return "Reads what is already there, before anything is changed.";
    // src/jobs/contacts.ts:15 — CONTACT_SCOPES[1]. The writes themselves are
    // esi.addContacts / editContacts / deleteContacts in that same job, driven
    // by `diffContacts`' return value, gated to the configured label only.
    case "esi-characters.write_contacts.v1":
      return `Adds, updates and removes contacts under the "${contactLabel}" label, to keep them matching your standing. Nothing outside that label is touched.`;
    // src/lib/esi/client.ts:18,332 — OPEN_WINDOW_SCOPE, used from
    // payouts/actions.ts:861 to open a character's info window in the client.
    case "esi-ui.open_window.v1":
      return "Opens a character's info window in your running client, from the payouts page.";
    // src/jobs/location.ts — LOCATION_SCOPE_REQUIRED, the only scope
    // `canReadLocation` gates on; `runLocationJob` reads esi.getLocation with
    // it. No line number: that file is added later in this same plan.
    case "esi-location.read_location.v1":
      return "The solar system, and the station or structure the character is docked in.";
    // src/jobs/location.ts — LOCATION_SCOPES_OPTIONAL[0]. esi.getStructureName,
    // resolved with the docked character's own token. Missing or refused, the
    // line still renders — just without a name on the structure.
    case "esi-universe.read_structures.v1":
      return "The structure's name, so a docked character reads as a place instead of a number. Without it, docked is all it says.";
    // src/jobs/location.ts — LOCATION_SCOPES_OPTIONAL[1]. esi.getOnline, used
    // only to choose between a current reading and a "last seen" one.
    case "esi-location.read_online.v1":
      return "Whether the character is logged in right now, so a reading left behind by one who has since logged off is shown as where they were last seen, not where they are.";
    default:
      return "This deployment requests this scope, but authGD has no description for it. Ask whoever runs it what it is for before granting.";
  }
}

/**
 * The six scopes are three facts, and the flat list said so nowhere: six rows
 * at one identical weight, of which exactly one — `write_contacts` — writes
 * anything at all, sitting second of six with nothing marking it out.
 *
 * So the shared fact per group is stated once, in the group's head, and the
 * `<dd>`s below carry only what differs. The head is also where the reader
 * gets the answer they actually came for ("does this thing change my stuff"),
 * ahead of any identifier.
 *
 * Grouping deliberately reorders relative to `EVE_SSO_SCOPES`. Config order
 * is an ops concern and carries no meaning for the person deciding; a scope
 * this list does not know about still renders, last, under a head that admits
 * the deployment added it. Groups with nothing in them do not render at all,
 * so a fork requesting only contact scopes gets one group rather than three
 * heads over two lists and an empty one.
 */
const SCOPE_GROUPS: { head: string; scopes: string[] }[] = [
  {
    head: "Contacts on your characters — the only thing authGD writes.",
    scopes: ["esi-characters.read_contacts.v1", "esi-characters.write_contacts.v1"],
  },
  {
    head: "Where your characters are, shown on your own account page and to admins.",
    scopes: [
      "esi-location.read_location.v1",
      "esi-universe.read_structures.v1",
      "esi-location.read_online.v1",
    ],
  },
  {
    head: "Your running EVE client.",
    scopes: ["esi-ui.open_window.v1"],
  },
];

/** `SCOPE_GROUPS` intersected with what this deployment actually requests,
 *  plus a trailing group for anything the list above does not place. */
function groupScopes(requested: string[]): { head: string; scopes: string[] }[] {
  const placed = new Set<string>();
  const groups = SCOPE_GROUPS.map(({ head, scopes }) => {
    const present = scopes.filter((s) => requested.includes(s));
    present.forEach((s) => placed.add(s));
    return { head, scopes: present };
  }).filter((g) => g.scopes.length > 0);

  const rest = requested.filter((s) => !placed.has(s));
  if (rest.length > 0) {
    groups.push({
      head: "Also requested by this deployment, and not described here.",
      scopes: rest,
    });
  }
  return groups;
}

// `await searchParams` below already forces dynamic rendering, so the
// getConfig() call cannot run at build time today. Declared anyway, matching
// every other getConfig() caller under src/app/: the ordering is load-bearing
// and undeclared otherwise, and a later edit that drops searchParams would turn
// this into a Docker build failure, where no config env is present.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sign in",
};

// Codes reaching this page: oauth_denied / oauth_expired / oauth_failed from
// the EVE callback, session_expired from account/actions.ts, account/page.tsx,
// admin-guard.ts, and either callback when the session is gone mid-link. The
// map itself lives in src/lib/error-redirects.ts, beside the builder every one
// of those producers now goes through — see that file for why.

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const message = lookupErrorMessage(LOGIN_ERRORS, error);
  const tone = loginErrorTone(error);
  const cfg = getConfig();
  const scopes = cfg.eveSso.scopes;
  const label = cfg.standings.label;
  const brand = cfg.brand;
  return (
    <main className="launch">
      <div className="launch__panel">
        {/* Empty alt, like the same mark in `SiteHeader` (ui.tsx:117) and every
            other decorative image in the app: the `<h1>` directly below already
            carries `brand.name`, so `"<name> emblem"` made a screen reader read
            the brand twice before reaching anything actionable — on the one
            page an unauthenticated visitor can get to. The emblem adds nothing
            the heading does not already say, which is what `alt=""` is for. */}
        {/* eslint-disable-next-line @next/next/no-img-element -- what next/image
            would add here is a re-encode at its default quality 75, and
            PRODUCT.md principle 5 asks for this artwork at "full quality" or not
            at all. This is the image that principle is about. Nothing else it
            offers applies: the mark is a fixed 180px at a known intrinsic size,
            so there is no layout shift to prevent and no art direction to do.
            emblem.webp is 512x512 — a ~3x cut for the 180px it is drawn at, which
            is the retina source, not principle 5's "large file scaled down".
            (The one thing next/image WOULD buy is a 1x srcset entry; that is a
            real cost, paid deliberately to keep the encode untouched.) */}
        {/* `fetchPriority="low"`, stated rather than left implied. This mark is
            79.8 KB of decorative WebP with `alt=""`, and the control below it —
            the entry point the whole page exists for — is 2,248 bytes carrying
            an explicit `high`. Left unset, the emblem contends for the same
            connection as that control on a first visit over a bad link, and the
            page's one actionable thing waits behind its own background. Saying
            `low` costs the emblem nothing a visitor can perceive (it is drawn
            at 180px, below the fold of nothing, and announces nothing to AT)
            and takes it out of the race. */}
        <img
          className="launch__seal"
          src={brand.sealUrl}
          alt=""
          width={180}
          height={180}
          fetchPriority="low"
        />
        <h1 className="launch__title">{brand.name}</h1>
        {/* Omitted entirely when unset rather than rendered empty: an empty
            <p> still occupies the stack's row gap, which reads as a missing
            image rather than as "this deployment has no motto". A newline in
            the value is a line break — the only formatting the field takes. */}
        {brand.motto && (
          <p className="launch__motto">
            {brand.motto.split("\n").map((line, i) => (
              <span key={i}>
                {i > 0 && <br />}
                {line}
              </span>
            ))}
          </p>
        )}
        {/* Same slot account/page.tsx uses: after the page head, before the
            body content. The seal and motto are this page's head, so a member
            bounced back here reads the reason before the disclosure rather
            than hunting for it underneath. Mounted unconditionally in 1A's slot
            mode rather than behind `message &&`: the `&&` form inserts a live
            region with its text already inside it, which is the case AT
            announces least reliably. Tone is per-code — a cancelled sign-in and
            an expired cookie are not faults, and only faults get the alarm. */}
        <Notice tone={tone}>{message}</Notice>
        {/* The control precedes the disclosure it is granting, not the other
            way around. The permission copy below runs long — a full
            paragraph plus a per-scope <dl> — and this is the only
            unauthenticated page in the app: every visit pays for reading it
            again before reaching the one thing most visitors came to press.
            Moving the button here means it renders without depending on the
            copy's length, at any viewport or zoom, rather than chasing a
            specific pixel count that the copy could blow past on the next
            scope added. The disclosure keeps its job — it is still fully
            rendered below, in document order, reachable by scrolling before
            the button is ever pressed. Nothing about "read before granting"
            required "read above the button": scrolling past a control
            without activating it is not consulting it. */}
        <a className="launch__action" href="/auth/eve/login">
          {/* Self-hosted, and the white cut. Hot-linked from
              web.ccpgamescdn.com this was a third-party request on the one
              unauthenticated page in the app: every visitor's IP and UA reached
              CCP's CDN before any sign-in was attempted, and with no
              preconnect, no fetchPriority and no fallback ground the degraded
              state was bare alt text on navy — for the product's only entry
              control. Served from /public it is same-origin, cached with the
              app, and cannot fail independently of the page. The black-large
              cut also made the primary action the darkest object on a dark
              page; CCP publishes this one. */}
          {/* eslint-disable-next-line @next/next/no-img-element -- a vendor
              brand mark, published by CCP at exactly the 270x45 it is drawn at
              and already down to 2,248 bytes. Nothing for the optimizer to
              reclaim, and re-encoding somebody else's brand asset is not ours
              to do. */}
          <img
            src="/brand/eve-sso-login-white-large.png"
            alt="Log in with EVE Online"
            width={270}
            height={45}
            fetchPriority="high"
          />
        </a>
        <div className="launch__disclosure">
          <p className="launch__disclosure-note">
            Sign in with any EVE character. authGD sets your Discord role; while your main
            is in the alliance it also syncs your Wanderer map access and manages the
            contacts under the <code>{label}</code> label on your characters, adding,
            updating and removing them at a set standing. Leaving the alliance drops your
            tier, never your account, characters, or Discord link.
          </p>
          {/* Guarded rather than always rendered: a whitespace-only
              EVE_SSO_SCOPES passes the zod .min(1) check and filters down to an
              empty array, and a bare "Scopes requested" heading with nothing
              under it reads as "authGD requests no scopes" instead of "this
              deployment is misconfigured". */}
          {scopes.length > 0 && (
            <>
              <p className="launch__scopes-head">Scopes requested</p>
              {/* One <dl> per group rather than one for the lot: the group's
                  head is a statement about every row under it, and a <p>
                  interleaved inside a single <dl> is neither a <dt> nor a
                  <dd> and has no defined relationship to either. Separate
                  lists keep each head adjacent to exactly the rows it
                  describes, in both channels.

                  dt is the raw identifier, dd is the one sentence it buys —
                  see describeScope above and the CSS comment on
                  .launch__scopes for why this runs the opposite way from a
                  plain "list of identifiers under one heading". A <Fragment>
                  per scope keeps each dt/dd pair a real boundary: still one
                  row per scope, never a joined string. */}
              {groupScopes(scopes).map((group) => (
                <Fragment key={group.head}>
                  <p className="launch__scope-group">{group.head}</p>
                  <dl className="launch__scopes">
                    {group.scopes.map((scope) => (
                      <Fragment key={scope}>
                        <dt>{scope}</dt>
                        <dd>{describeScope(scope, label)}</dd>
                      </Fragment>
                    ))}
                  </dl>
                </Fragment>
              ))}
            </>
          )}
        </div>
        {brand.footer && <p className="launch__foot">{brand.footer}</p>}
      </div>
    </main>
  );
}
