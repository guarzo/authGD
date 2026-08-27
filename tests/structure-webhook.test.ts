import { describe, expect, it, vi } from "vitest";
import type { DiscordEmbed } from "@/core/structure-event";
import { postStructureWebhook, resolveStructureWebhookUrl } from "@/lib/ops-webhook";
import { testConfig } from "./helpers/config";

const SAMPLE_EMBED: DiscordEmbed = {
  title: "Home Fortizar in Jita is under attack",
  color: 0xf1c40f,
  timestamp: "2026-01-01T00:00:00.000Z",
  footer: { text: "Notification 555" },
};

function cfgWith(over: { structure?: string; ops?: string; roleId?: string }) {
  const base = testConfig();
  return {
    ...base,
    syncMode: "live" as const,
    discord: {
      ...base.discord,
      structureWebhookUrl: over.structure,
      opsWebhookUrl: over.ops,
      structureRoleId: over.roleId,
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
      postStructureWebhook(
        cfgWith({}),
        SAMPLE_EMBED,
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/not configured/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts to the resolved url", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
    );
    await postStructureWebhook(
      cfgWith({ structure: "https://s.example" }),
      SAMPLE_EMBED,
      fetchImpl,
    );
    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url).toBe("https://s.example");
  });

  it("posts the embed under `embeds`", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await postStructureWebhook(
      cfgWith({ structure: "https://s.example" }),
      SAMPLE_EMBED,
      fetchImpl,
    );
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { embeds: DiscordEmbed[] };
    expect(body.embeds).toEqual([SAMPLE_EMBED]);
  });

  // Discord does NOT fire notifications for a mention inside an embed, and a
  // webhook's own default `allowed_mentions` (when the field is omitted) is
  // `{parse: ["users"]}` — NOT `["everyone"]`, so an omitted field would not
  // resolve this role ping either way. Both halves of the actual contract
  // still matter: `content` carries the mention, and `allowed_mentions.roles`
  // is the ONLY thing that makes it ping.
  it("puts the role mention in top-level content with a matching allow-list, when a role is configured", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await postStructureWebhook(
      cfgWith({ structure: "https://s.example", roleId: "123456789012345678" }),
      SAMPLE_EMBED,
      fetchImpl,
    );
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      content?: string;
      allowed_mentions: { parse: string[]; users: string[]; roles: string[] };
    };
    expect(body.content).toContain("<@&123456789012345678>");
    expect(body.allowed_mentions.roles).toEqual(["123456789012345678"]);
  });

  it("omits content and allows no mentions when no role is configured", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await postStructureWebhook(
      cfgWith({ structure: "https://s.example" }),
      SAMPLE_EMBED,
      fetchImpl,
    );
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      content?: string;
      allowed_mentions: { parse: string[]; users: string[]; roles: string[] };
    };
    expect(body.content).toBeUndefined();
    expect(body.allowed_mentions).toEqual({ parse: [], users: [], roles: [] });
  });

  it("suppresses the post in dry-run without throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const cfg = {
      ...cfgWith({ structure: "https://s.example" }),
      syncMode: "dry-run" as const,
    };
    await expect(
      postStructureWebhook(cfg, SAMPLE_EMBED, fetchImpl),
    ).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
