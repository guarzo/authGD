import { fleetV2Error } from "@/lib/fleet-api-v2";
export const dynamic = "force-dynamic";
// No legacy Stop adapter: source control joins receipt semantics in its own slice.
export function GET(_req?: Request) {
  return Promise.resolve(fleetV2Error("update_required"));
}
export const POST = GET;
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
export const OPTIONS = GET;
export function HEAD(_req?: Request) {
  return Promise.resolve(fleetV2Error("update_required", { head: true }));
}
