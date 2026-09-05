import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { account, fleetPairingRequest } from "@/db/schema";
import { accountErrorUrl, loginErrorUrl } from "@/lib/error-redirects";
import { canReadPayouts } from "@/services/payouts";
import { getSessionAccount } from "@/services/session";
import { navFor } from "@/app/_components/nav-items";
import { Notice, SiteHeader } from "@/app/_components/ui";
import { brandProps } from "@/app/_components/brand-server";
import { Submit } from "@/app/_components/submit";
import { approvePairingAction } from "./actions";

// Reads the session cookie and hits the DB on every request, same as every
// other session-gated page in this app (see account/page.tsx).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pair a device",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A short, human-checkable derived form of a device's public key — never
 * the key material itself (the brief: "Do not reveal device key material
 * beyond a short derived public-key fingerprint"). SHA-256 of the raw SPKI
 * bytes, truncated to 10 bytes/20 hex characters and grouped for reading;
 * this is a display aid, not a security boundary — a fingerprint collision
 * would only ever mislead a human comparing two approvals, never let a
 * device impersonate another one to `verifyFleetRequest`, which checks the
 * whole key.
 */
function fingerprint(publicKeySpkiB64: string): string {
  const spki = Buffer.from(publicKeySpkiB64, "base64");
  const digest = createHash("sha256")
    .update(spki)
    .digest("hex")
    .slice(0, 20)
    .toUpperCase();
  return digest.match(/.{1,4}/g)!.join(" ");
}

type PairingState = "closed" | "pending" | "approved";

export default async function FleetPairPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const cfg = getConfig();
  const sid = (await cookies()).get(cfg.sessionCookieName)?.value;
  const sess = sid ? await getSessionAccount(getDb(), sid) : null;
  // Same "a cookie that no longer resolves is a genuine expiry; no cookie at
  // all is a first-time visitor" distinction account/page.tsx already draws.
  if (!sess) redirect(sid ? loginErrorUrl("session_expired") : "/login");

  const [acc] = await getDb()
    .select()
    .from(account)
    .where(eq(account.id, sess.accountId));
  // Deliberately tier-only, ignoring status/cryo — the exact rule
  // `approvePairing` itself enforces (fleet-pairing.ts), so a cryo Member
  // sees the identical page a fully-active one would.
  if (!acc || acc.tier !== "member") {
    redirect(accountErrorUrl("fleet_pairing_member_required"));
  }

  const nav = navFor({
    canReadPayouts: await canReadPayouts(getDb(), sess.accountId),
    isAdmin: acc.isAdmin,
  });

  const now = new Date();
  const [row] = UUID_RE.test(id)
    ? await getDb()
        .select()
        .from(fleetPairingRequest)
        .where(eq(fleetPairingRequest.id, id))
    : [];

  const state: PairingState =
    !row || row.expiresAt.getTime() <= now.getTime() || row.consumedAt !== null
      ? "closed"
      : row.approvedAt !== null
        ? "approved"
        : "pending";

  return (
    <>
      <SiteHeader items={nav} current="/account" {...brandProps()} />
      <main id="main" tabIndex={-1} className="page page--narrow">
        <h1>Pair a Wingman device</h1>

        {state === "closed" && (
          <Notice tone="info">
            This pairing request is no longer available. It may have expired, already been
            completed, or never existed. Start pairing again from Wingman.
          </Notice>
        )}

        {state === "approved" && (
          <Notice tone="info">
            Approved. Waiting for the desktop app to finish pairing.
          </Notice>
        )}

        {state === "pending" && row && (
          <>
            <p className="dim">
              A device is requesting to pair with your account for fleet sharing.
              Approving lets it publish and read sparse DPS and{" "}
              <span className="mono">SCRAM/POINT</span> for your linked characters, only
              while you are both in the same ESI-verified fleet.
            </p>
            <dl className="facts">
              <dt>Key fingerprint</dt>
              <dd className="mono">{fingerprint(row.publicKeySpkiB64)}</dd>
              <dt>Expires</dt>
              <dd className="mono">{row.expiresAt.toISOString()}</dd>
            </dl>
            <form action={approvePairingAction.bind(null, id)}>
              <Submit className="btn btn--primary" pendingLabel="approving…">
                Approve
              </Submit>
            </form>
          </>
        )}
      </main>
    </>
  );
}
