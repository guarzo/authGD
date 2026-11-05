import type { NextRequest } from "next/server";
import { fleetV2Error } from "@/lib/fleet-api-v2";

export const dynamic = "force-dynamic";

// Retirement wins before method/auth/body/service admission, even while Off.
// Define HEAD/OPTIONS explicitly: Next must not synthesize a GET or 204 path.
export function GET(_req?: NextRequest) {
  return Promise.resolve(fleetV2Error("update_required"));
}
export const PUT = GET;
export const POST = GET;
export const PATCH = GET;
export const DELETE = GET;
export const OPTIONS = GET;
export function HEAD(_req?: NextRequest) {
  return Promise.resolve(fleetV2Error("update_required", { head: true }));
}
