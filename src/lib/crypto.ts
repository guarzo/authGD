import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const b64u = (b: Buffer) => b.toString("base64url");

export function encryptToken(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [b64u(iv), b64u(cipher.getAuthTag()), b64u(ct)].join(".");
}

export function decryptToken(blob: string, key: Buffer): string {
  const [iv, tag, ct] = blob.split(".").map((p) => Buffer.from(p, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
