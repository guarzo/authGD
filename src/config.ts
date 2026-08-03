import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  SESSION_COOKIE_NAME: z.string().default("authgd_session"),
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .refine((s) => Buffer.from(s, "base64").length === 32, {
      message: "TOKEN_ENCRYPTION_KEY must be base64 of exactly 32 bytes",
    }),
  APP_BASE_URL: z.string().url(),
  ALLIANCE_ID: z.coerce.number().int().positive(),
  // Also the last-admin recovery mechanism: malformed values must fail startup.
  BOOTSTRAP_ADMIN_CHARACTER_IDS: z
    .string()
    .default("")
    .transform((raw, ctx) => {
      const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
      const ids = parts.map(Number);
      if (parts.some((p) => !/^\d+$/.test(p))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `BOOTSTRAP_ADMIN_CHARACTER_IDS must be comma-separated numeric ids, got: ${raw}`,
        });
        return z.NEVER;
      }
      if (new Set(ids).size !== ids.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "BOOTSTRAP_ADMIN_CHARACTER_IDS contains duplicates",
        });
        return z.NEVER;
      }
      return ids;
    }),
  EVE_SSO_CLIENT_ID: z.string().min(1),
  EVE_SSO_CLIENT_SECRET: z.string().min(1),
  EVE_SSO_SCOPES: z.string().min(1),
  EVE_SCOPE_SET_VERSION: z.coerce.number().int().positive().default(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_CLIENT_SECRET: z.string().min(1),
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  DISCORD_ROLE_ID_FLYGD: z.string().min(1),
  DISCORD_ROLE_ID_BLUE: z.string().min(1),
  DISCORD_ROLE_ID_GREEN: z.string().min(1),
  DISCORD_OPS_WEBHOOK_URL: z.string().url().optional().or(z.literal("")),
  WANDERER_BASE_URL: z.string().url(),
  WANDERER_API_KEY: z.string().min(1),
  WANDERER_ACL_ID: z.string().min(1),
  // Matched against the in-game contact label by exact string equality
  // (src/jobs/contacts.ts), so the case here must match the label as typed in
  // the client — the default mirrors the label FlyGD actually uses.
  STANDINGS_LABEL: z.string().min(1).default("FLYGD"),
  STANDINGS_VALUE: z.coerce.number().min(-10).max(10).default(5),
  // CCP requires ESI consumers to send identifying contact info (F6).
  ESI_CONTACT: z.string().min(1),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const e = envSchema.parse(env);
  return {
    databaseUrl: e.DATABASE_URL,
    sessionCookieName: e.SESSION_COOKIE_NAME,
    tokenEncryptionKey: Buffer.from(e.TOKEN_ENCRYPTION_KEY, "base64"),
    appBaseUrl: e.APP_BASE_URL,
    allianceId: e.ALLIANCE_ID,
    bootstrapAdminCharacterIds: e.BOOTSTRAP_ADMIN_CHARACTER_IDS,
    eveSso: {
      clientId: e.EVE_SSO_CLIENT_ID,
      clientSecret: e.EVE_SSO_CLIENT_SECRET,
      scopes: e.EVE_SSO_SCOPES.split(/\s+/).filter(Boolean),
      scopeSetVersion: e.EVE_SCOPE_SET_VERSION,
    },
    discord: {
      clientId: e.DISCORD_CLIENT_ID,
      clientSecret: e.DISCORD_CLIENT_SECRET,
      botToken: e.DISCORD_BOT_TOKEN,
      guildId: e.DISCORD_GUILD_ID,
      roleIds: {
        flygd: e.DISCORD_ROLE_ID_FLYGD,
        blue: e.DISCORD_ROLE_ID_BLUE,
        green: e.DISCORD_ROLE_ID_GREEN,
      },
      opsWebhookUrl: e.DISCORD_OPS_WEBHOOK_URL || undefined,
    },
    wanderer: {
      baseUrl: e.WANDERER_BASE_URL,
      apiKey: e.WANDERER_API_KEY,
      aclId: e.WANDERER_ACL_ID,
    },
    standings: { label: e.STANDINGS_LABEL, value: e.STANDINGS_VALUE },
    esiContact: e.ESI_CONTACT,
  };
}

let cached: Config | undefined;
export function getConfig(): Config {
  cached ??= loadConfig();
  return cached;
}
