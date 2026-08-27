import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  SESSION_COOKIE_NAME: z.string().default("authgd_session"),
  TOKEN_ENCRYPTION_KEY: z.string().refine((s) => Buffer.from(s, "base64").length === 32, {
    message: "TOKEN_ENCRYPTION_KEY must be base64 of exactly 32 bytes",
  }),
  // Normalised to origin + path, with any trailing slash removed, because
  // three call sites CONCATENATE this value rather than URL-joining it: the
  // two OAuth redirect_uri strings in src/lib/esi/sso.ts and
  // src/lib/discord/oauth.ts. z.string().url() accepts anything a URL parser
  // accepts, so without this a stray character produces a redirect_uri that
  // no longer matches what is registered in the developer portal — and it
  // fails at login, not at startup, as an unexplained mismatch:
  //
  //   https://host/            → https://host//auth/eve/callback
  //   https://host/app/?x=1    → https://host/app/?x=1/auth/eve/callback
  //
  // A query or fragment is meaningless on a base URL, so dropping both is
  // safe. Every other consumer goes through `new URL(path, appBaseUrl)` and
  // was never affected either way.
  //
  // Normalises rather than rejects: a deployment whose secret carries one of
  // these today already has broken OAuth, and refusing to boot would escalate
  // that to a total outage with nothing to catch it — /api/health does not
  // read config, so the Fly check reports healthy while every page 500s.
  // Mirrors the normalisation the Wanderer client already applies to its own
  // base URL (src/lib/wanderer/client.ts).
  APP_BASE_URL: z
    .string()
    .url()
    .transform((s) => {
      const u = new URL(s);
      return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
    }),
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
  DISCORD_ROLE_ID_MEMBER: z.string().min(1),
  DISCORD_ROLE_ID_ASSOCIATE: z.string().min(1),
  DISCORD_ROLE_ID_ALUMNI: z.string().min(1),
  DISCORD_OPS_WEBHOOK_URL: z.string().url().optional().or(z.literal("")),
  DISCORD_STRUCTURE_WEBHOOK_URL: z.string().url().optional().or(z.literal("")),
  // A BARE snowflake, never `<@&id>` — the poster wraps it in the mention
  // syntax itself. Stricter than the sibling DISCORD_ROLE_ID_* vars (which are
  // `z.string().min(1)`, and stay that way; do not retrofit them here, it is
  // out of scope and would break tests/helpers/env.ts) because a pasted
  // mention or a role *name* typed into this one still "looks configured" and
  // would otherwise post a dud, unresolved mention at 3am instead of failing
  // at boot where someone is looking.
  DISCORD_STRUCTURE_ROLE_ID: z
    .string()
    .regex(/^\d{17,20}$/)
    .optional()
    .or(z.literal("")),
  WANDERER_BASE_URL: z.string().url(),
  WANDERER_API_KEY: z.string().min(1),
  WANDERER_ACL_ID: z.string().min(1),
  // Matched against the in-game contact label ignoring capitalization and
  // surrounding whitespace (src/core/contact-label.ts), so the case here need
  // not match what members typed in the client — but two of a member's labels
  // that differ only that way are refused rather than guessed between. The app
  // OWNS this label and deletes anything under it that isn't a member, so the
  // default names the app rather than the corp: point it at a label created for
  // authGD, never one humans also curate.
  STANDINGS_LABEL: z.string().min(1).default("authgd"),
  STANDINGS_VALUE: z.coerce.number().min(-10).max(10).default(5),
  // CCP requires ESI consumers to send identifying contact info.
  ESI_CONTACT: z.string().min(1),
  // REQUIRED with no default, deliberately: every other arrangement has a
  // silent failure mode. Defaulting to "dry-run" would let a missing
  // production secret turn sync into an unnoticed no-op; defaulting to "live"
  // would make the destructive configuration the one you get by forgetting.
  // Requiring it means both environments state intent.
  SYNC_MODE: z.enum(["live", "dry-run"]),

  // Display only. The enum values are member|associate|alumni|pending and do
  // not change; these decide what a member reads. Optional with generic
  // defaults so a fresh clone carries no deployment's vocabulary, and
  // deliberately unvalidated beyond "is a string" — a corp's own tier names
  // are not ours to constrain.
  TIER_LABEL_MEMBER: z.string().default("Member"),
  TIER_LABEL_ASSOCIATE: z.string().default("Associate"),
  TIER_LABEL_ALUMNI: z.string().default("Alumni"),
  TIER_LABEL_PENDING: z.string().default("Pending"),

  // The corp's cut of a payout, applied to operations at creation. Kept as a
  // STRING all the way to the `numeric(5, 2)` column rather than parsed to a
  // number: a float round-trip is exactly how "12.10" becomes "12.099999" in a
  // money column, and every other consumer of corpSharePct already speaks
  // strings (setCorpSharePct, the action's own `/^\d+(\.\d{1,2})?$/` guard).
  //
  // Only ever read when an operation is CREATED. The value is then persisted
  // per-operation, so changing this env var re-rates new operations and leaves
  // every finalized one showing the rate it was actually paid at. That is the
  // whole reason the column survives the UI editor's removal — see
  // `setCorpShareAction`.
  PAYOUT_CORP_SHARE_PCT: z
    .string()
    .default("10")
    .refine((s) => /^\d+(\.\d{1,2})?$/.test(s), {
      message: "PAYOUT_CORP_SHARE_PCT must be a percentage like 10 or 12.50",
    })
    .refine((s) => Number(s) <= 100, {
      message: "PAYOUT_CORP_SHARE_PCT must be between 0 and 100",
    }),

  BRAND_NAME: z.string().default("authGD"),
  BRAND_TAGLINE: z.string().default("Auth"),
  // Empty means "render nothing", not "render an empty element" — the login
  // page omits the node entirely. A newline is a line break; the login page
  // splits on it.
  BRAND_MOTTO: z.string().default(""),
  BRAND_FOOTER: z.string().default(""),
  BRAND_MARK_URL: z.string().default("/brand/mark.webp"),
  BRAND_SEAL_URL: z.string().default("/brand/emblem.webp"),
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
        member: e.DISCORD_ROLE_ID_MEMBER,
        associate: e.DISCORD_ROLE_ID_ASSOCIATE,
        alumni: e.DISCORD_ROLE_ID_ALUMNI,
      },
      opsWebhookUrl: e.DISCORD_OPS_WEBHOOK_URL || undefined,
      structureWebhookUrl: e.DISCORD_STRUCTURE_WEBHOOK_URL || undefined,
      structureRoleId: e.DISCORD_STRUCTURE_ROLE_ID || undefined,
    },
    wanderer: {
      baseUrl: e.WANDERER_BASE_URL,
      apiKey: e.WANDERER_API_KEY,
      aclId: e.WANDERER_ACL_ID,
    },
    standings: { label: e.STANDINGS_LABEL, value: e.STANDINGS_VALUE },
    esiContact: e.ESI_CONTACT,
    syncMode: e.SYNC_MODE,
    payoutCorpSharePct: e.PAYOUT_CORP_SHARE_PCT,
    tierLabels: {
      member: e.TIER_LABEL_MEMBER,
      associate: e.TIER_LABEL_ASSOCIATE,
      alumni: e.TIER_LABEL_ALUMNI,
      pending: e.TIER_LABEL_PENDING,
    },
    brand: {
      name: e.BRAND_NAME,
      tagline: e.BRAND_TAGLINE,
      motto: e.BRAND_MOTTO,
      footer: e.BRAND_FOOTER,
      markUrl: e.BRAND_MARK_URL,
      sealUrl: e.BRAND_SEAL_URL,
    },
  };
}

let cached: Config | undefined;
export function getConfig(): Config {
  cached ??= loadConfig();
  return cached;
}
