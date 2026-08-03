import { describe, expect, it, vi } from "vitest";
import { OpsWebhookError, postOpsWebhook, postOpsWebhookOrThrow } from "@/lib/ops-webhook";
import { testConfig } from "./helpers/config";

describe("postOpsWebhook", () => {
  it("posts content to the configured webhook", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await postOpsWebhook(testConfig(), "job failed", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://discord.example/webhook");
    expect(JSON.parse(init.body as string)).toEqual({ content: "job failed" });
  });

  it("is a no-op when no webhook is configured", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const cfg = testConfig({ DISCORD_OPS_WEBHOOK_URL: "" });
    await postOpsWebhook(cfg, "x", fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never throws, even when the post fails", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    await expect(postOpsWebhook(testConfig(), "x", fetchImpl)).resolves.toBeUndefined();
  });
});

describe("postOpsWebhookOrThrow", () => {
  it("posts content to the configured webhook", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await postOpsWebhookOrThrow(testConfig(), "alert", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("is still a no-op when no webhook is configured", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await postOpsWebhookOrThrow(
      testConfig({ DISCORD_OPS_WEBHOOK_URL: "" }),
      "x",
      fetchImpl,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("THROWS on HTTP failure so the dead-letter job retries", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    await expect(postOpsWebhookOrThrow(testConfig(), "x", fetchImpl)).rejects.toBeInstanceOf(
      OpsWebhookError,
    );
  });

  it("THROWS on network failure", async () => {
    const fetchImpl = (async () => {
      throw new Error("down");
    }) as typeof fetch;
    await expect(postOpsWebhookOrThrow(testConfig(), "x", fetchImpl)).rejects.toBeInstanceOf(
      OpsWebhookError,
    );
  });
});
