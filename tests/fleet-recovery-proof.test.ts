import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  canonicalDevicePublicKeyB64,
  normalizeDevicePublicKeyB64,
} from "@/lib/fleet-signature";
import {
  recoveryInitiationFresh,
  recoveryInitiationPreimage,
  verifyRecoveryInitiation,
} from "@/lib/fleet-recovery-proof";
import { fleetKeyPair } from "./helpers/fleet-sharing";
import { recoveryInitiation } from "./helpers/fleet-recovery";

const NOW = new Date("2026-09-07T12:00:00.000Z");
it("keeps raw V1 serialization while normalized DER aliases identify the same key", () => {
  const keys = fleetKeyPair();
  const canonical = Buffer.from(keys.publicKeySpki);
  const alias = Buffer.concat([canonical, Buffer.from([0])]);
  expect(canonicalDevicePublicKeyB64(alias)).toBe(alias.toString("base64"));
  expect(normalizeDevicePublicKeyB64(alias)).toBe(canonical.toString("base64"));
  expect(normalizeDevicePublicKeyB64(Buffer.alloc(91))).toBeNull();
  expect(normalizeDevicePublicKeyB64(Buffer.from("bad"))).toBeNull();
});

it("binds the exact independent initiation five-line preimage without final newline", () => {
  const keys = fleetKeyPair();
  const args = recoveryInitiation(keys, NOW, "A".repeat(43));
  const binding = {
    canonicalOrigin: "https://auth.example",
    requestId: args.requestId,
    issuedAt: args.issuedAt,
    publicKeySpkiB64: Buffer.from(keys.publicKeySpki).toString("base64"),
  };
  const expected =
    "fleet-recovery-init-v1\nhttps://auth.example\n" +
    "A".repeat(43) +
    "\n2026-09-07T12:00:00.000Z\n" +
    createHash("sha256").update(keys.publicKeySpki).digest("hex");
  expect(recoveryInitiationPreimage(binding).toString("utf8")).toBe(expected);
  expect(verifyRecoveryInitiation(binding, args.initiationSignature)).toBe(true);
  for (const changed of [
    { ...binding, canonicalOrigin: "https://other.example" },
    { ...binding, issuedAt: "2026-09-07T12:00:00.001Z" },
    { ...binding, requestId: "B".repeat(43) },
  ])
    expect(verifyRecoveryInitiation(changed, args.initiationSignature)).toBe(false);
});

it.each([
  [-60001, false],
  [-60000, true],
  [0, true],
  [59999, true],
  [60000, false],
])("freshness delta %s is %s (exclusive upper deadline)", (delta, expected) => {
  expect(
    recoveryInitiationFresh(NOW.toISOString(), new Date(NOW.getTime() + Number(delta))),
  ).toBe(expected);
});
it.each([
  "2026-09-07T12:00:00Z",
  "2026-09-07T12:00:00.000+00:00",
  "2026-02-30T12:00:00.000Z",
  "bad",
])("rejects non-roundtripping UTC milliseconds %s", (issuedAt) => {
  expect(recoveryInitiationFresh(issuedAt, NOW)).toBe(false);
});
