import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  SESSION_COOKIE_NAME: z.string().default("authgd_session"),
  TOKEN_ENCRYPTION_KEY: z.string().refine((s) => Buffer.from(s, "base64").length === 32, {
    message: "TOKEN_ENCRYPTION_KEY must be base64 of exactly 32 bytes",
  }),
  // Trailing slashes are stripped because three call sites CONCATENATE this
  // value rather than URL-joining it — the two OAuth redirect_uri strings in
  // src/lib/esi/sso.ts and src/lib/discord/oauth.ts. There, a trailing slash
  // produces `https://host//auth/eve/callback`, which no longer matches the
  // URI registered in the developer portal, and z.string().url() accepts the
  // slash happily — so it surfaces much later as an unexplained redirect
  // mismatch rather than a config error. Every other consumer goes through
  // `new URL(path, appBaseUrl)`, which is unaffected either way.
  // Normalising rather than rejecting: a deployment whose secret has a
  // trailing slash today already has broken OAuth, and refusing to boot would
  // turn that into a total outage — with no health check to catch it, since
  // /api/health does not read config. Mirrors the same normalisation the
  // Wanderer client already does to its own base URL.
  APP_BASE_URL: z
    .string()
    .url()
    .transform((s) => s.replace(/\/+$/, "")),
  ALLIANCE_ID: z.coerce.number().int().positive(),
  // Also the last-admin recovery mechanism: malformed values must fail startup.
  BOOTSTRAP_ADMIN_CHARACTER_IDS: z
    .string()
    .default("")
    .transform((raw, ctx) => {
      const parts = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
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
  // the client. The app OWNS this label and deletes anything under it that
  // isn't a member, so the default names the app rather than the corp: point
  // it at a label created for authGD, never one humans also curate.
  STANDINGS_LABEL: z.string().min(1).default("authgd"),
  STANDINGS_VALUE: z.coerce.number().min(-10).max(10).default(5),
  // CCP requires ESI consumers to send identifying contact info (F6).
  ESI_CONTACT: z.string().min(1),
  // REQUIRED with no default, deliberately: every other arrangement has a
  // silent failure mode. Defaulting to "dry-run" would let a missing
  // production secret turn sync into an unnoticed no-op; defaulting to "live"
  // would make the destructive configuration the one you get by forgetting.
  // Requiring it means both environments state intent. See
  // docs/superpowers/specs/2026-08-03-local-dev-setup.md (D1).
  SYNC_MODE: z.enum(["live", "dry-run"]),
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
    syncMode: e.SYNC_MODE,
  };
}

let cached: Config | undefined;
export function getConfig(): Config {
  cached ??= loadConfig();
  return cached;
}
