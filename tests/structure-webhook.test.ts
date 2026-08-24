import { describe, expect, it, vi } from "vitest";
import { postStructureWebhook, resolveStructureWebhookUrl } from "@/lib/ops-webhook";
import { testConfig } from "./helpers/config";

function cfgWith(over: { structure?: string; ops?: string }) {
  const base = testConfig();
  return {
    ...base,
    syncMode: "live" as const,
    discord: {
      ...base.discord,
      structureWebhookUrl: over.structure,
      opsWebhookUrl: over.ops,
    },
  };
}

describe("resolveStructureWebhookUrl", () => {
  it("prefers the structure webhook", () => {
    expect(
      resolveStructureWebhookUrl(
        cfgWith({ structure: "https://s.example", ops: "https://o.example" }),
      ),
    ).toBe("https://s.example");
  });

  it("falls back to the ops webhook", () => {
    expect(resolveStructureWebhookUrl(cfgWith({ ops: "https://o.example" }))).toBe(
      "https://o.example",
    );
  });

  it("is undefined when neither is set", () => {
    expect(resolveStructureWebhookUrl(cfgWith({}))).toBeUndefined();
  });
});

describe("postStructureWebhook", () => {
  it("throws when no webhook is configured, rather than silently succeeding", async () => {
    const fetchImpl = vi.fn();
    await expect(
      postStructureWebhook(cfgWith({}), "boom", fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/not configured/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts to the resolved url", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await postStructureWebhook(
      cfgWith({ structure: "https://s.example" }),
      "hello",
      fetchImpl as unknown as typeof fetch,
    );
    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://s.example");
  });
});
