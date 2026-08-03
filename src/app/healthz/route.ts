import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { getConfig } from "@/config";

export const dynamic = "force-dynamic";

/**
 * Liveness for the `web` process group. Wired to Fly's http_service checks, so
 * a sustained failure here restarts the machine.
 *
 * Asserts ONLY that this process booted with valid configuration. It
 * deliberately does not touch the database: this endpoint can restart a
 * machine, and a Postgres blip must never take down every healthy web machine
 * at once. Database reachability lives in /readyz, which is not wired to
 * restarts.
 *
 * The gap this closes: getConfig() is lazy, so before this existed a web
 * machine with missing or malformed env booted "successfully" and returned 500
 * on every real request, with the deploy reported as green.
 *
 * Unauthenticated by design — Fly's checker sends no credentials. It therefore
 * returns the NAMES of failing env vars and never their values or the raw
 * error text, which goes to stderr instead.
 */
export function GET(): NextResponse {
  try {
    getConfig();
  } catch (err) {
    console.error("healthz: config invalid", err);
    const badVars =
      err instanceof ZodError
        ? [...new Set(err.issues.map((i) => i.path.join(".")).filter(Boolean))].sort()
        : [];
    return NextResponse.json(
      { status: "error", check: "config", invalid: badVars },
      { status: 503 },
    );
  }
  return NextResponse.json({ status: "ok" });
}
