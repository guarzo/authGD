import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { canonicalFleetRequest, snapshotRequestBinding } from "@/lib/fleet-signature";
import fixture from "./fixtures/fleet-snapshot-publication-v1.json";
import signature from "./fixtures/fleet-signature-v1.json";

it.each(fixture.vectors)(
  "binds the cross-language $method $path vector without changing signatures",
  (v) => {
    const input = {
      protocol: 1 as const,
      method: v.method as "GET" | "PUT",
      path: v.path,
      sessionId: v.session_id,
      issuedAt: v.issued_at,
      revision: v.revision,
      bodySha256: v.body_sha256,
    };
    const canonical = canonicalFleetRequest(input);
    expect(snapshotRequestBinding(canonical)).toBe(v.binding);
    expect(
      createHash("sha256").update(fixture.domain).update(canonical).digest("hex"),
    ).toBe(v.binding);
    if (v.method === "PUT")
      expect(Buffer.from(canonical).toString()).toBe(signature.canonical_text);
    for (const mutation of [
      { method: "POST" as const },
      { path: "/api/fleet/v1/catalogue" },
      { sessionId: "B".repeat(43) },
      { issuedAt: "2026-01-01T00:00:00Z" },
      { revision: 8 },
      { bodySha256: "0".repeat(64) },
    ])
      expect(
        snapshotRequestBinding(canonicalFleetRequest({ ...input, ...mutation })),
      ).not.toBe(v.binding);
    expect(
      snapshotRequestBinding(Buffer.concat([canonical, Buffer.from("\n")])),
    ).not.toBe(v.binding);
    expect(createHash("sha256").update(canonical).digest("hex")).not.toBe(v.binding);
  },
);
