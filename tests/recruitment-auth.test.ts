import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { testConfig } from "./helpers/config";

const scopes = [
  "esi-wallet.read_character_wallet.v1",
  "esi-contracts.read_character_contracts.v1",
  "esi-assets.read_assets.v1",
  "esi-skills.read_skills.v1",
  "esi-skills.read_skillqueue.v1",
];
vi.mock("@/config", async (original) => ({
  ...(await original<typeof import("@/config")>()),
  getConfig: () => testConfig({ EVE_SSO_SCOPES: scopes.join(" ") }),
}));

const { default: LoginPage } = await import("@/app/login/page");

describe("shared recruitment authentication", () => {
  it("requests every recruitment read permission in the deployment example", async () => {
    const example = await readFile(".env.example", "utf8");
    const configured = /^EVE_SSO_SCOPES="([^"]+)"/m.exec(example)?.[1].split(/\s+/);
    for (const scope of scopes) expect(configured).toContain(scope);
  });

  it("explains the private reads and admin collection purpose at login", async () => {
    const html = renderToStaticMarkup(
      await LoginPage({ searchParams: Promise.resolve({}) }),
    );
    expect(html).toContain("Recruitment evidence");
    expect(html).toContain("admins");
    expect(html).toContain("Wallet journal and market transactions");
    expect(html).toContain("Contracts, their items and auction bids");
    expect(html).toContain("Current assets");
    expect(html).toContain("Trained skills");
    expect(html).toContain("Current skill queue");
    expect(html).not.toContain("authGD has no description for it");
  });
});
