/**
 * Dev seed — accounts across every tier, plus session cookies you can paste
 * into a browser to be logged in as any of them without EVE SSO.
 *
 *   npm run db:seed              upsert (safe to re-run)
 *   npm run db:seed -- --reset   TRUNCATE first, for a clean slate
 *
 * IDEMPOTENT BY DEFAULT. Character ids are fixed (the 91_000_0xx block, chosen
 * to sit clear of e2e's 90_000_0xx counter so the two can never collide), and
 * every row is upserted, so re-running converges instead of failing on a
 * duplicate primary key or silently doubling the fixture.
 *
 * Deliberately NOT shared with e2e/helpers.ts or tests/helpers/seed.ts. Those
 * two already seed independently with different semantics — e2e auto-increments
 * and only inserts, because it gets a truncated database before every test.
 * Making all three share one parameterized helper costs more than the ~20
 * duplicated lines and would put the e2e suite at risk to make dev nicer.
 * The session hashing is NOT duplicated: createSession below is the real one.
 */
import { eq, sql } from "drizzle-orm";
import { loadConfig, type Config } from "@/config";
import { createDb, type Db } from "@/db";
import { account, character } from "@/db/schema";
import { encryptToken } from "@/lib/crypto";
import { createSession, revokeAccountSessions } from "@/services/session";

type Tier = "flygd" | "blue" | "green";

type SeedSpec = {
  label: string;
  name: string;
  mainId: number;
  tier: Tier;
  isAdmin?: boolean;
  tierLocked?: boolean;
  status?: "active" | "cryo";
  alts?: Array<{ id: number; name: string }>;
};

/**
 * Fixed ids are what make the upsert converge — do not renumber casually, or a
 * re-run against an existing dev database leaves the old rows orphaned beside
 * the new ones.
 */
const SEED: SeedSpec[] = [
  {
    label: "admin",
    name: "Admin Prime",
    mainId: 91_000_001,
    tier: "flygd",
    isAdmin: true,
    alts: [
      { id: 91_000_101, name: "Admin Prime Alt" },
      { id: 91_000_102, name: "Admin Prime Hauler" },
    ],
  },
  {
    label: "flygd",
    name: "Flygd Pilot",
    mainId: 91_000_002,
    tier: "flygd",
    alts: [{ id: 91_000_103, name: "Flygd Pilot Alt" }],
  },
  { label: "blue", name: "Blue Pilot", mainId: 91_000_003, tier: "blue" },
  { label: "green", name: "Green Pilot", mainId: 91_000_004, tier: "green" },
  // Two states the admin pages need something to render.
  {
    label: "cryo",
    name: "Cryo Pilot",
    mainId: 91_000_005,
    tier: "green",
    status: "cryo",
  },
  {
    label: "locked",
    name: "Locked Pilot",
    mainId: 91_000_006,
    tier: "blue",
    tierLocked: true,
  },
];

/** Same 11 tables as tests/helpers/db.ts. Never touches the pgboss schema. */
async function truncateAll(db: Db): Promise<void> {
  await db.execute(sql`
    TRUNCATE account, "character", discord_link, session, bootstrap_admin_grant,
      outbox, oauth_transaction, contact_sync_state, sync_run,
      wanderer_acl_observation, audit_log RESTART IDENTITY CASCADE
  `);
}

/**
 * A dev seed has no legitimate remote use, and both paths write rows — --reset
 * destructively, the default by polluting. Refuse anything that is not
 * obviously a local database. ALLOW_REMOTE_SEED=1 is the deliberate override.
 */
export function isLocalDatabase(url: string): boolean {
  try {
    // toLowerCase is load-bearing: `postgres:` is a NON-SPECIAL URL scheme, so
    // WHATWG leaves the host case as written (`http:` would lowercase it) —
    // `postgres://LOCALHOST/db` yields hostname "LOCALHOST". Postgres hostnames
    // are case-insensitive, so without this a differently-cased .env is refused
    // and the developer is pointed at ALLOW_REMOTE_SEED=1, training them to
    // disable the guard to work around a false rejection.
    // IPv6 arrives bracketed: new URL("postgres://[::1]/db").hostname === "[::1]".
    const host = new URL(url).hostname.toLowerCase();
    return ["localhost", "127.0.0.1", "[::1]"].includes(host);
  } catch {
    return false; // unparseable → not provably local → refuse
  }
}

async function upsertAccount(db: Db, cfg: Config, spec: SeedSpec): Promise<string> {
  // account.main_character_id's composite FK is DEFERRED (checked at COMMIT),
  // so the account and its main character must land in ONE transaction.
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ accountId: character.accountId })
      .from(character)
      .where(eq(character.id, spec.mainId));

    const fields = {
      tier: spec.tier,
      tierLocked: spec.tierLocked ?? false,
      status: spec.status ?? ("active" as const),
      isAdmin: spec.isAdmin ?? false,
      mainCharacterId: spec.mainId,
    };

    let accountId: string;
    if (existing) {
      accountId = existing.accountId;
      await tx.update(account).set(fields).where(eq(account.id, accountId));
    } else {
      const [acc] = await tx.insert(account).values(fields).returning();
      accountId = acc.id;
    }

    for (const ch of [{ id: spec.mainId, name: spec.name }, ...(spec.alts ?? [])]) {
      const row = {
        id: ch.id,
        accountId,
        name: ch.name,
        ownerHash: `dev-oh-${ch.id}`,
        // Realistic shape, but dry-run refuses the refresh so it is never used
        // against the real SSO. Encrypted with the configured key so the row
        // decrypts like any other.
        refreshTokenEnc: encryptToken(`dev-refresh-${ch.id}`, cfg.tokenEncryptionKey),
        scopes: [...cfg.eveSso.scopes],
        tokenStatus: "valid" as const,
        // flygd tier is derived from alliance membership by the sync jobs.
        allianceId: spec.tier === "flygd" ? cfg.allianceId : null,
      };
      await tx
        .insert(character)
        .values(row)
        .onConflictDoUpdate({ target: character.id, set: row });
    }
    return accountId;
  });
}

export async function seedDev(
  db: Db,
  cfg: Config,
): Promise<Array<{ spec: SeedSpec; accountId: string; sessionId: string }>> {
  const out = [];
  for (const spec of SEED) {
    const accountId = await upsertAccount(db, cfg, spec);
    // Re-running issues fresh cookies rather than accumulating sessions; any
    // cookie printed by a previous run stops working.
    await revokeAccountSessions(db, accountId);
    const sessionId = await createSession(db, accountId);
    out.push({ spec, accountId, sessionId });
  }
  return out;
}

async function main(): Promise<void> {
  const reset = process.argv.slice(2).includes("--reset");
  const cfg = loadConfig();

  if (!isLocalDatabase(cfg.databaseUrl) && process.env.ALLOW_REMOTE_SEED !== "1") {
    console.error(
      `refusing to seed a non-local database (${new URL(cfg.databaseUrl).host}).\n` +
        `This script writes fixture accounts and, with --reset, TRUNCATEs every table.\n` +
        `Set ALLOW_REMOTE_SEED=1 if you genuinely mean it.`,
    );
    process.exit(2);
  }

  const { db, pool } = createDb(cfg.databaseUrl);
  try {
    if (reset) {
      console.log("--reset: truncating all tables");
      await truncateAll(db);
    }
    const seeded = await seedDev(db, cfg);

    const cookieName = cfg.sessionCookieName;
    console.log(`\nSeeded ${seeded.length} accounts.\n`);
    for (const { spec, sessionId } of seeded) {
      const flags = [
        spec.tier,
        spec.isAdmin ? "admin" : null,
        spec.tierLocked ? "tier-locked" : null,
        spec.status === "cryo" ? "cryo" : null,
        spec.alts?.length ? `${spec.alts.length} alt(s)` : null,
      ]
        .filter(Boolean)
        .join(", ");
      console.log(`${spec.label.padEnd(7)} ${spec.name.padEnd(18)} (${flags})`);
      console.log(`  ${cookieName}=${sessionId}\n`);
    }
    console.log(
      `To log in as one of them, set a cookie named "${cookieName}" with the\n` +
        `value above, for ${cfg.appBaseUrl}, path /. In devtools:\n` +
        `  Application → Cookies → ${cfg.appBaseUrl}\n` +
        `See docs/ops.md ("Logging in without EVE SSO") for the full procedure.`,
    );
  } finally {
    await pool.end();
  }
}

// Only run when invoked as a script, so tests can import seedDev directly.
if (process.argv[1]?.endsWith("seed-dev.ts")) {
  main().catch((err: unknown) => {
    console.error("seed failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
