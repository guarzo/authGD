import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const b64u = (b: Buffer) => b.toString("base64url");

const KEY_VERSION = "v1";

/** Malformed/unsupported blob shape — distinct from a GCM auth failure. */
export class TokenFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenFormatError";
  }
}

/** Produces `v1.iv.tag.ciphertext` (base64url segments). The version segment
 * exists so a future key rotation can stage dual-key reads by version. */
export function encryptToken(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [KEY_VERSION, b64u(iv), b64u(cipher.getAuthTag()), b64u(ct)].join(".");
}

export function decryptToken(blob: string, key: Buffer): string {
  const parts = blob.split(".");
  if (parts.length !== 4) {
    throw new TokenFormatError(
      `token blob must have 4 dot-separated segments, got ${parts.length}`,
    );
  }
  const [version, ivB64, tagB64, ctB64] = parts;
  if (version !== KEY_VERSION) {
    throw new TokenFormatError(`unsupported token key version: ${version}`);
  }
  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  const ct = Buffer.from(ctB64, "base64url");
  if (iv.length !== 12 || tag.length !== 16 || ct.length === 0) {
    throw new TokenFormatError("token blob segment has invalid length");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
