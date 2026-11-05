import { expect, it } from "vitest";
import * as api from "@/core/fleet-api-v2";
import { closedFleetV2Code } from "@/lib/fleet-api-v2";
it("internal code mapping never leaks unknown or prototype property names", () => {
  for (const code of ["provider_error", "__proto__", "constructor", "toString"])
    expect(closedFleetV2Code(code)).toBe("service_unavailable");
  expect(closedFleetV2Code("invalid_session")).toBe("unauthorized");
  expect(closedFleetV2Code("not_eligible")).toBe("forbidden");
});

it("closes basic and pre-session outputs before authority is issued", () => {
  expect(
    api.SessionRenewedSchema?.safeParse({
      protocol: 2,
      expires_at: "2026-09-07T12:00:00.000Z",
    }).success,
  ).toBe(true);
  expect(
    api.ParticipationResultSchema?.safeParse({
      protocol: 2,
      participation: { enabled: false, generation: 0 },
    }).success,
  ).toBe(true);
  expect(
    api.RecoveryCompletedSchema?.safeParse({
      protocol: 2,
      result: "retry_later",
      retry_after_ms: 86400001,
    }).success,
  ).toBe(false);
  expect(
    api.RecoveryCompletedSchema?.safeParse({
      protocol: 2,
      result: "device_revoked",
      session_id: "A".repeat(43),
    }).success,
  ).toBe(false);
});
it("pre-session inputs require explicit canonical capabilities, keys, tokens and proofs", () => {
  expect(
    api.PairingBeginSchema?.safeParse({
      protocol: 2,
      public_key_spki_b64url: "YQ",
      requested_capabilities: [],
    }).success,
  ).toBe(true);
  expect(
    api.PairingBeginSchema?.safeParse({
      protocol: 2,
      public_key_spki_b64url: "YR",
      requested_capabilities: [],
    }).success,
  ).toBe(false);
  expect(
    api.PairingBeginSchema?.safeParse({ protocol: 2, public_key_spki_b64url: "YQ" })
      .success,
  ).toBe(false);
  expect(
    api.PairingCompleteSchema?.safeParse({
      protocol: 2,
      completion_signature: "A".repeat(85) + "B",
    }).success,
  ).toBe(false);
});
