import { describe, expect, it } from "vitest";
import { decryptToken, encryptToken } from "@/lib/crypto";

const key = Buffer.alloc(32, 9);

describe("token crypto", () => {
  it("round-trips", () => {
    const blob = encryptToken("refresh-token-value", key);
    expect(blob).not.toContain("refresh-token-value");
    expect(decryptToken(blob, key)).toBe("refresh-token-value");
  });

  it("produces distinct ciphertexts (random IV)", () => {
    expect(encryptToken("x", key)).not.toBe(encryptToken("x", key));
  });

  it("fails on tampered ciphertext", () => {
    const blob = encryptToken("x", key);
    const parts = blob.split(".");
    parts[2] = parts[2].slice(0, -2) + "AA";
    expect(() => decryptToken(parts.join("."), key)).toThrow();
  });
});
