import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { brandProps } from "@/app/_components/brand-server";
import { navFor } from "@/app/_components/nav-items";
import { Notice, RuleHead, SiteHeader } from "@/app/_components/ui";
import {
  FLEET_SHARING_ERRORS,
  FLEET_SHARING_NOTICES,
  loginErrorUrl,
  lookupErrorMessage,
} from "@/lib/error-redirects";
import { getSessionAccount } from "@/services/session";
import { getFleetSharingSetup } from "@/services/fleet-sharing-view";
import { FleetCheckForm } from "./check-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Fleet sharing" };

export default async function FleetSharingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const cfg = getConfig();
  const db = getDb();
  const sid = (await cookies()).get(cfg.sessionCookieName)?.value;
  const sess = sid ? await getSessionAccount(db, sid) : null;
  if (!sess) redirect(sid ? loginErrorUrl("session_expired") : "/login");
  const [setup, { error, notice }] = await Promise.all([
    getFleetSharingSetup(db, sess.accountId),
    searchParams,
  ]);
  return (
    <>
      <SiteHeader
        items={navFor({ canReadPayouts: setup.eligible, isAdmin: setup.isAdmin })}
        current="/account"
        section
        {...brandProps()}
      />
      <main id="main" tabIndex={-1} className="page page--narrow">
        <div className="page__head">
          <h1>Fleet sharing</h1>
          <p className="page__lede">
            Authorize one linked character to read its fleet. Your linked in-fleet alts
            are included automatically, without their own Fleet Read authorization or
            individual selection.
          </p>
        </div>
        <Notice tone="bad">{lookupErrorMessage(FLEET_SHARING_ERRORS, error)}</Notice>
        <Notice>{lookupErrorMessage(FLEET_SHARING_NOTICES, notice)}</Notice>
        {!setup.eligible ? (
          <Notice tone="warn">{FLEET_SHARING_ERRORS.not_eligible}</Notice>
        ) : setup.characters.length === 0 ? (
          <p className="dim">
            No linked characters. <a href="/account">Add a character from Your account</a>{" "}
            to authorize Fleet Read.
          </p>
        ) : (
          <FleetCheckForm characters={setup.characters} />
        )}
        <RuleHead as="h2">Wingman devices</RuleHead>
        <p className="table-note">
          This check does not start telemetry sharing. Pairing from Wingman is not
          available yet.
        </p>
        <p className="btn-row">
          <a className="btn" href="/account/fleet-devices">
            Manage paired devices
          </a>
        </p>
      </main>
    </>
  );
}
