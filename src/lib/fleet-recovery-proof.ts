import { createHash, createPublicKey, verify } from "node:crypto";
import { decodeDevicePublicKeyB64 } from "@/lib/fleet-signature";

type RecoveryBinding = {
  canonicalOrigin: string;
  challengeId: string;
  nonce: string;
  publicKeySpkiB64: string;
};

/** Fixed UTF-8 lines, no final newline. The service supplies the configured
 * origin, not Host/Origin headers or a value from the request body. */
export function recoveryChallengePreimage(input: RecoveryBinding): Buffer {
  const keyDigest = createHash("sha256")
    .update(decodeDevicePublicKeyB64(input.publicKeySpkiB64))
    .digest("hex");
  return Buffer.from(
    [
      "fleet-recovery-v1",
      input.canonicalOrigin,
      input.challengeId,
      input.nonce,
      keyDigest,
    ].join("\n"),
    "utf8",
  );
}

export function verifyRecoveryProof(input: RecoveryBinding, signature: string): boolean {
  return verifyProof(input.publicKeySpkiB64, recoveryChallengePreimage(input), signature);
}

export function canonicalBase64url(value: string, length: number): boolean {
  return (
    typeof value === "string" &&
    value.length === length &&
    /^[A-Za-z0-9_-]+$/.test(value) &&
    Buffer.from(value, "base64url").toString("base64url") === value
  );
}

export function recoveryInitiationFresh(issuedAt: string, now: Date): boolean {
  if (
    typeof issuedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(issuedAt)
  )
    return false;
  const millis = Date.parse(issuedAt);
  return (
    Number.isFinite(millis) &&
    new Date(millis).toISOString() === issuedAt &&
    now.getTime() >= millis - 60000 &&
    now.getTime() < millis + 60000
  );
}

type InitiationBinding = {
  canonicalOrigin: string;
  requestId: string;
  issuedAt: string;
  publicKeySpkiB64: string;
};
export function recoveryInitiationPreimage(input: InitiationBinding): Buffer {
  return Buffer.from(
    [
      "fleet-recovery-init-v1",
      input.canonicalOrigin,
      input.requestId,
      input.issuedAt,
      createHash("sha256")
        .update(Buffer.from(input.publicKeySpkiB64, "base64"))
        .digest("hex"),
    ].join("\n"),
    "utf8",
  );
}
export function verifyRecoveryInitiation(
  input: InitiationBinding,
  signature: string,
): boolean {
  return (
    canonicalBase64url(input.requestId, 43) &&
    verifyProof(input.publicKeySpkiB64, recoveryInitiationPreimage(input), signature)
  );
}

function verifyProof(
  publicKeySpkiB64: string,
  preimage: Buffer,
  signature: string,
): boolean {
  if (!canonicalBase64url(signature, 86)) return false;
  const bytes = Buffer.from(signature, "base64url");
  try {
    const key = createPublicKey({
      key: Buffer.from(decodeDevicePublicKeyB64(publicKeySpkiB64)),
      format: "der",
      type: "spki",
    });
    return key.asymmetricKeyType === "ed25519" && verify(null, preimage, key, bytes);
  } catch {
    // Corrupt stored key material remains unproven, never an account outcome.
    return false;
  }
}
