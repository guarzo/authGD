import { describe, expect, it, vi } from "vitest";
import { postOpsWebhook } from "@/lib/ops-webhook";
import { testConfig } from "./helpers/config";

describe("postOpsWebhook", () => {
  it("posts content to the configured webhook", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 204 }));
    await postOpsWebhook(testConfig(), "job failed", fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://discord.example/webhook");
    expect(JSON.parse(init.body as string)).toEqual({ content: "job failed" });
  });

  it("is a no-op when no webhook is configured", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 204 }));
    const cfg = testConfig({ DISCORD_OPS_WEBHOOK_URL: "" });
    await postOpsWebhook(cfg, "x", fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never throws, even when the post fails", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    await expect(postOpsWebhook(testConfig(), "x", fetchImpl)).resolves.toBeUndefined();
  });
});
