import { describe, expect, it } from "vitest";
import { TokenFormatError, decryptToken, encryptToken } from "@/lib/crypto";

const key = Buffer.alloc(32, 9);

describe("token crypto", () => {
  it("round-trips", () => {
    const blob = encryptToken("refresh-token-value", key);
    expect(blob).not.toContain("refresh-token-value");
    expect(blob.startsWith("v1.")).toBe(true);
    expect(decryptToken(blob, key)).toBe("refresh-token-value");
  });

  it("produces distinct ciphertexts (random IV)", () => {
    expect(encryptToken("x", key)).not.toBe(encryptToken("x", key));
  });

  it("fails on tampered ciphertext", () => {
    const blob = encryptToken("x", key);
    const parts = blob.split(".");
    // XOR the first ciphertext byte so the blob always differs from the original
    const ct = Buffer.from(parts[3], "base64url");
    ct[0] ^= 0xff;
    parts[3] = ct.toString("base64url");
    expect(() => decryptToken(parts.join("."), key)).toThrow();
  });

  it("throws TokenFormatError on malformed blobs", () => {
    expect(() => decryptToken("not-a-blob", key)).toThrow(TokenFormatError);
    expect(() => decryptToken("a.b.c", key)).toThrow(TokenFormatError);
    expect(() => decryptToken("v9.a.b.c", key)).toThrow(/key version/);
  });
});
