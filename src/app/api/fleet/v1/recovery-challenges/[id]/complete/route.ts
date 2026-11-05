import { fleetV2Error } from "@/lib/fleet-api-v2";
export const dynamic = "force-dynamic";
// Do not even await params: every spelling/method is retired before admission.
export function GET(_req?: Request, _ctx?: { params: Promise<{ id: string }> }) {
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
