import { describe, expect, it } from "vitest";

// Deliberately its own file. getConfig() caches its result in a module-level
// variable, so "config is invalid" cannot be exercised in the same module
// registry as the happy path — vitest isolates each test file, which gives us
// a clean registry with a broken env.
//
// Only two vars are set; everything else the schema requires is absent.
process.env.DATABASE_URL = "";
process.env.ALLIANCE_ID = "not-a-number";
for (const k of [
  "TOKEN_ENCRYPTION_KEY",
  "APP_BASE_URL",
  "EVE_SSO_CLIENT_ID",
  "EVE_SSO_CLIENT_SECRET",
  "EVE_SSO_SCOPES",
  "DISCORD_CLIENT_ID",
  "DISCORD_CLIENT_SECRET",
  "DISCORD_BOT_TOKEN",
  "DISCORD_GUILD_ID",
  "DISCORD_ROLE_ID_FLYGD",
  "DISCORD_ROLE_ID_BLUE",
  "DISCORD_ROLE_ID_GREEN",
  "WANDERER_BASE_URL",
  "WANDERER_API_KEY",
  "WANDERER_ACL_ID",
  "ESI_CONTACT",
  "SYNC_MODE",
]) {
  delete process.env[k];
}

const { GET: healthz } = await import("@/app/healthz/route");
const { GET: readyz } = await import("@/app/readyz/route");

describe("health endpoints with invalid config", () => {
  it("/healthz returns 503 naming the invalid vars", async () => {
    const res = healthz();
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      status: string;
      check: string;
      invalid: string[];
    };
    expect(body.status).toBe("error");
    expect(body.check).toBe("config");
    expect(body.invalid).toContain("TOKEN_ENCRYPTION_KEY");
    expect(body.invalid).toContain("SYNC_MODE");
  });

  it("/healthz leaks names only — no values, no zod prose", async () => {
    // This endpoint is unauthenticated: anyone on the internet can read it.
    // Names are enough to diagnose; messages and values are not for them.
    const text = await healthz().text();
    expect(text).not.toContain("not-a-number");
    expect(text).not.toMatch(/invalid_type|Required|expected/i);
  });

  it("/readyz reports config and does NOT attempt the database", async () => {
    // DATABASE_URL is one of the invalid vars, so probing the DB here would
    // only produce a confusing secondary error on top of the real one.
    const res = await readyz();
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, any>;
    expect(body.config).toBe("error");
    expect(body.database).toBe("skipped");
    expect(body.worker.status).toBe("skipped");
  });
});
