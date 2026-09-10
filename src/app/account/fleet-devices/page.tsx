import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { account } from "@/db/schema";
import { navFor } from "@/app/_components/nav-items";
import { Notice, RuleHead, Scroller, SiteHeader } from "@/app/_components/ui";
import { brandProps } from "@/app/_components/brand-server";
import { ConfirmNotice } from "@/app/_components/confirm-notice";
import { RelativeTime } from "@/app/_components/relative-time";
import { formatAgo, formatDeadline } from "@/app/_components/format-ago";
import {
  ConfirmArmScope,
  ConfirmCost,
  ConfirmSubmit,
} from "@/app/_components/confirm-submit";
import {
  FLEET_DEVICES_ERRORS,
  loginErrorUrl,
  lookupErrorMessage,
} from "@/lib/error-redirects";
import { listFleetDevicesForAccount } from "@/services/fleet-pairing";
import { getSessionAccount } from "@/services/session";
import { revokeFleetDeviceAction } from "./actions";
import { fleetDevicesConfirmation } from "./view";

// Reads the session cookie and hits the DB on every request, same reasoning
// as account/page.tsx's own `dynamic` export.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Fleet-sharing devices",
};

/** The id a row's revoke cost sentence lives at — see the render below for
 *  why it stays permanently in the accessible tree rather than revealing on
 *  arm (`ConfirmCost`'s `"hidden"` visibility). */
const revokeCostId = (deviceId: string) => `fleet-device-revoke-cost-${deviceId}`;

/** A stable, absolute name for a device with no name of its own — the only
 *  fact this page shows that could tell two rows apart for a screen-reader
 *  or speech-input member, the same job a character's own name does for
 *  `account/page.tsx`'s `unlink` buttons. Deliberately absolute (a plain
 *  date), not `formatAgo`'s relative text: a relative string changes every
 *  render and can round two different devices to the same words ("3d ago"),
 *  where the calendar date they were paired on cannot. */
function pairedOnLabel(pairedAt: Date): string {
  return pairedAt.toISOString().slice(0, 10);
}

export default async function FleetDevicesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; done?: string; at?: string }>;
}) {
  const cfg = getConfig();
  const sid = (await cookies()).get(cfg.sessionCookieName)?.value;
  const sess = sid ? await getSessionAccount(getDb(), sid) : null;
  // Same "expired vs. never had one" distinction account/page.tsx draws.
  if (!sess) redirect(sid ? loginErrorUrl("session_expired") : "/login");

  const { error, done, at } = await searchParams;
  const db = getDb();
  // `tier`/`isAdmin` alone, not the much heavier `getAccountView` join
  // account/page.tsx needs for its own manifest — this page only needs
  // enough to compute which nav items the shell offers (`navFor`).
  const [[acc], devices] = await Promise.all([
    db
      .select({ tier: account.tier, isAdmin: account.isAdmin })
      .from(account)
      .where(eq(account.id, sess.accountId)),
    listFleetDevicesForAccount(db, sess.accountId),
  ]);
  const nav = navFor({
    canReadPayouts: acc?.tier === "member",
    isAdmin: acc?.isAdmin ?? false,
  });
  const message = lookupErrorMessage(FLEET_DEVICES_ERRORS, error);
  const confirmation = fleetDevicesConfirmation(done);
  const now = Date.now();

  return (
    <>
      <SiteHeader items={nav} current="/account" section {...brandProps()} />
      <main id="main" tabIndex={-1} className="page page--narrow">
        <div className="page__head">
          <h1>Fleet-sharing devices</h1>
          <p className="page__lede">
            Wingman desktops you have paired to broadcast your own characters&rsquo; DPS
            and EWAR state to the rest of your fleet. Revoking one takes effect
            immediately and is permanent — a revoked device can never be re-paired;
            reconnecting needs a freshly generated device key.
          </p>
        </div>

        {/* Mounted unconditionally, same reasoning as account/page.tsx's own
            `Notice`/`ConfirmNotice` pair: both revalidate this route in
            place, so the slot has to already exist for AT to hear either
            arrive. */}
        <Notice tone="bad">{message}</Notice>
        <ConfirmNotice text={confirmation} at={at} />

        {devices.length === 0 ? (
          <p className="dim">
            No devices paired. In a Wingman build with Fleet sharing controls, open
            Settings › Previews and choose Connect.
          </p>
        ) : (
          <>
            <RuleHead as="h2">Paired devices ({devices.length})</RuleHead>
            <Scroller label="Paired fleet-sharing devices">
              <table className="log">
                <thead>
                  <tr>
                    <th scope="col">Paired</th>
                    <th scope="col">Session expires</th>
                    <th scope="col">
                      <span className="visually-hidden">Revoke</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <ConfirmArmScope>
                    {devices.map((d) => {
                      const pairedIso = d.pairedAt.toISOString();
                      const sessionIso = d.sessionExpiresAt?.toISOString() ?? null;
                      const pairedOn = pairedOnLabel(d.pairedAt);
                      return (
                        <tr key={d.id}>
                          <td>
                            <RelativeTime
                              iso={pairedIso}
                              initial={formatAgo(pairedIso, now)}
                            />
                          </td>
                          <td>
                            {sessionIso ? (
                              <RelativeTime
                                iso={sessionIso}
                                initial={formatDeadline(sessionIso, now)}
                                countdown
                              />
                            ) : (
                              "—"
                            )}
                          </td>
                          <td>
                            <form
                              action={revokeFleetDeviceAction.bind(null, d.id)}
                              className="inline-form"
                            >
                              <ConfirmSubmit
                                className="btn btn--quiet btn--danger-quiet"
                                armedClassName="btn btn--danger"
                                label="revoke"
                                restName={`revoke device paired ${pairedOn}`}
                                confirmName={`confirm revoke device paired ${pairedOn}`}
                                describedBy={revokeCostId(d.id)}
                              />
                            </form>
                            {/* `"hidden"`, not the default `"reveal"`: this cell
                                is a plain narrow table cell, not the manifest's
                                flex disclosure panel with its own
                                `flex-basis: 100%` escape hatch (account/
                                page.tsx's own note on that panel) — revealing
                                prose here would grow the cell horizontally,
                                exactly the #108/#111/#112 failure that note
                                describes. Assistive tech still gets the cost
                                unconditionally; only the sighted reveal is
                                skipped. */}
                            <ConfirmCost id={revokeCostId(d.id)} visibility="hidden">
                              Immediately stops this device from reading or publishing
                              fleet data. Permanent — it can never be re-paired.
                            </ConfirmCost>
                          </td>
                        </tr>
                      );
                    })}
                  </ConfirmArmScope>
                </tbody>
              </table>
            </Scroller>
          </>
        )}
      </main>
    </>
  );
}
