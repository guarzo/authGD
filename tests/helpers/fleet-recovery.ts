import { createHash, createPublicKey, randomBytes, sign } from "node:crypto";
import { fleetKeyPair } from "./fleet-sharing";

// Independent client construction; no production proof builder signs expectations.
export function recoveryInitiation(
  keys: ReturnType<typeof fleetKeyPair>,
  now = new Date(),
  requestId = randomBytes(32).toString("base64url"),
  origin = "https://auth.example",
) {
  const canonical = createPublicKey({
    key: Buffer.from(keys.publicKeySpki),
    format: "der",
    type: "spki",
  }).export({ format: "der", type: "spki" });
  const issuedAt = now.toISOString();
  const initiationSignature = sign(
    null,
    Buffer.from(
      [
        "fleet-recovery-init-v1",
        origin,
        requestId,
        issuedAt,
        createHash("sha256").update(canonical).digest("hex"),
      ].join("\n"),
    ),
    keys.privateKey,
  ).toString("base64url");
  return {
    publicKeySpki: keys.publicKeySpki,
    requestId,
    issuedAt,
    initiationSignature,
    now,
  };
}

export function recoveryCompletion(
  keys: ReturnType<typeof fleetKeyPair>,
  challenge: { challengeId: string; nonce: string },
  now = new Date(),
) {
  const canonical = createPublicKey({
    key: Buffer.from(keys.publicKeySpki),
    format: "der",
    type: "spki",
  }).export({ format: "der", type: "spki" });
  return {
    ...challenge,
    now,
    recoverySignature: sign(
      null,
      Buffer.from(
        [
          "fleet-recovery-v1",
          "https://auth.example",
          challenge.challengeId,
          challenge.nonce,
          createHash("sha256").update(canonical).digest("hex"),
        ].join("\n"),
      ),
      keys.privateKey,
    ).toString("base64url"),
  };
}
