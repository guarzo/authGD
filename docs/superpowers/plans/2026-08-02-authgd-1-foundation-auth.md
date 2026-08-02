# authGD Plan 1/3: Foundation & Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Project foundation plus the complete authentication/identity layer: EVE SSO login with PKCE, alt linking with reclaim semantics, Discord OAuth linking, server-side sessions, bootstrap admin grants, and the member account page.

**Architecture:** Next.js App Router monolith with Drizzle/Postgres. All identity rules (account creation pessimistic-Green, no-main rule, transfer reclaim, bootstrap admin) live in `src/services/` as plain functions taking a Drizzle transaction handle, so they are unit-testable without HTTP. OAuth flows use a durable `oauth_transaction` table (state + PKCE). State changes that require syncing write `outbox` rows in the same transaction (the worker that consumes them is Plan 2).

**Tech Stack:** TypeScript (strict), Next.js 15 (App Router), Drizzle ORM + node-postgres, Postgres 16, zod, jose (EVE JWT verify), vitest, msw (HTTP mocking in tests).

**Spec:** `docs/superpowers/specs/2026-08-02-authgd-design.md` — authoritative for all behavior.

## Global Constraints

- TypeScript `strict: true`; no `any` in committed code.
- Tiers are exactly `flygd | blue | green`; account statuses exactly `active | cryo`; token statuses exactly `valid | invalid | needs_reauth | missing`.
- Refresh tokens are AES-256-GCM encrypted at rest with `TOKEN_ENCRYPTION_KEY` (32-byte base64).
- Sessions are server-side rows; the cookie holds only an opaque id (`authgd_session`, HttpOnly, SameSite=Lax, Secure in prod). Signed-cookie-only sessions are ruled out.
- OAuth: every flow — EVE **and Discord** — uses single-use, expiring (10 min) `oauth_transaction` rows binding state hash + intent + initiator + PKCE verifier (S256). Callbacks check the exact expected intent and reject all others.
- **Identity mutations are transaction-only:** `src/db` exports `DbTx` (the transaction handle type) alongside `Dbx = Db | DbTx`. Every mutating function in `accounts.ts` / `discord-link.ts` takes `DbTx`, so the compiler rejects calls outside `db.transaction()` — required both for `FOR UPDATE` locks to mean anything and for the deferred main-character FK to be checked at commit. Tests wrap service calls in `ctx.db.transaction(...)` via small helpers.
- **Lock order (deadlock avoidance), documented in `accounts.ts`:** character row(s) first, then account row(s); never the reverse. `demoteAdmin` locks only account rows.
- **Design deviation from spec (approved):** the spec named `arctic`/`openid-client` for OAuth; the plan implements both flows directly with `jose` + fetch instead. Rationale: EVE SSO needs custom JWT claim handling (`sub`/`owner`/`scp`) and our durable `oauth_transaction` state machine regardless; the remaining protocol surface (two token POSTs, two authorize URLs) is smaller than the integration surface of the libraries, and arctic has no EVE provider. Recorded in the spec's decision log.
- Account creation is pessimistic: new accounts are unlocked Green with unresolved affiliation; no ESI affiliation calls in any OAuth callback.
- Every character login/link requests the full configured scope set (`EVE_SSO_SCOPES`, default `esi-characters.read_contacts.v1 esi-characters.write_contacts.v1`).
- All identity mutations write `audit_log` rows; sync-relevant changes also write `outbox` rows in the same transaction.
- Bootstrap admin: one-time consumable grant recorded in `bootstrap_admin_grant`; last admin cannot be demoted.
- `discord_user_id` and linked character ids are unique across accounts.
- Commit after every green test cycle. Conventional commit messages (`feat:`, `test:`, `chore:`).
- All tests run with `npm test` (vitest). Integration tests need `TEST_DATABASE_URL` (dev compose Postgres); they must create/migrate their own schema.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `.gitignore`, `.env.example`, `docker-compose.dev.yml`, `src/app/layout.tsx`, `src/app/page.tsx`, `tests/smoke.test.ts`

**Interfaces:**
- Produces: a building Next.js app; `npm test` runs vitest; `docker compose -f docker-compose.dev.yml up -d` provides Postgres at `postgres://authgd:authgd@localhost:5433/authgd` (and `authgd_test` for tests).

- [ ] **Step 1: Write package.json and configs**

`package.json`:

```json
{
  "name": "authgd",
  "private": true,
  "version": "0.1.0",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "tsx src/db/migrate.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "drizzle-orm": "^0.44.0",
    "jose": "^6.0.0",
    "next": "^15.4.0",
    "pg": "^8.13.0",
    "pg-boss": "^10.3.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/pg": "^8.11.0",
    "@types/react": "^19.0.0",
    "drizzle-kit": "^0.31.0",
    "msw": "^2.7.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

`next.config.ts`:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
};

export default nextConfig;
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
```

`.gitignore`:

```
node_modules/
.next/
.env
*.tsbuildinfo
next-env.d.ts
```

`.env.example`:

```
DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd
SESSION_COOKIE_NAME=authgd_session
TOKEN_ENCRYPTION_KEY=   # base64 of 32 random bytes: openssl rand -base64 32
APP_BASE_URL=http://localhost:3000

ALLIANCE_ID=99000001
BOOTSTRAP_ADMIN_CHARACTER_IDS=90000001

EVE_SSO_CLIENT_ID=
EVE_SSO_CLIENT_SECRET=
EVE_SSO_SCOPES=esi-characters.read_contacts.v1 esi-characters.write_contacts.v1
EVE_SCOPE_SET_VERSION=1

DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_BOT_TOKEN=
DISCORD_GUILD_ID=
DISCORD_ROLE_ID_FLYGD=
DISCORD_ROLE_ID_BLUE=
DISCORD_ROLE_ID_GREEN=
DISCORD_OPS_WEBHOOK_URL=

WANDERER_BASE_URL=
WANDERER_API_KEY=
WANDERER_MAP_SLUG=
WANDERER_ACL_ID=

STANDINGS_LABEL=flygd
STANDINGS_VALUE=5
```

`docker-compose.dev.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: authgd
      POSTGRES_PASSWORD: authgd
      POSTGRES_DB: authgd
    ports:
      - "5433:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./scripts/init-test-db.sql:/docker-entrypoint-initdb.d/init-test-db.sql
volumes:
  pgdata:
```

Also create `scripts/init-test-db.sql`:

```sql
CREATE DATABASE authgd_test OWNER authgd;
```

`src/app/layout.tsx`:

```tsx
import type { ReactNode } from "react";

export const metadata = { title: "authGD" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

`src/app/page.tsx`:

```tsx
export default function Home() {
  return <main>authGD</main>;
}
```

`tests/smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";

describe("smoke", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 2: Install and verify**

Run: `npm install && npm test && npm run typecheck`
Expected: smoke test PASS, typecheck clean.

- [ ] **Step 3: Start dev Postgres**

Run: `docker compose -f docker-compose.dev.yml up -d && sleep 3 && docker compose -f docker-compose.dev.yml exec postgres psql -U authgd -c "\l" | grep authgd_test`
Expected: `authgd_test` database listed.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js + vitest + dev postgres"
```

---

### Task 2: Config and token crypto

**Files:**
- Create: `src/config.ts`, `src/lib/crypto.ts`
- Test: `tests/config.test.ts`, `tests/crypto.test.ts`

**Interfaces:**
- Produces: `loadConfig(env?: NodeJS.ProcessEnv): Config` and lazy singleton `getConfig()`; `Config` fields used later: `databaseUrl`, `appBaseUrl`, `sessionCookieName`, `tokenEncryptionKey: Buffer`, `allianceId: number`, `bootstrapAdminCharacterIds: number[]`, `eveSso: { clientId, clientSecret, scopes: string[], scopeSetVersion: number }`, `discord: { clientId, clientSecret, botToken, guildId, roleIds: { flygd, blue, green }, opsWebhookUrl?: string }`, `wanderer: { baseUrl, apiKey, mapSlug, aclId }`, `standings: { label: string, value: number }`.
- Produces: `encryptToken(plain: string, key: Buffer): string`, `decryptToken(blob: string, key: Buffer): string` (format `iv.tag.ciphertext`, each base64url).

- [ ] **Step 1: Write failing tests**

`tests/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "@/config";

const validEnv = {
  DATABASE_URL: "postgres://x/y",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  APP_BASE_URL: "http://localhost:3000",
  ALLIANCE_ID: "99000001",
  BOOTSTRAP_ADMIN_CHARACTER_IDS: "90000001,90000002",
  EVE_SSO_CLIENT_ID: "cid",
  EVE_SSO_CLIENT_SECRET: "sec",
  EVE_SSO_SCOPES: "esi-characters.read_contacts.v1 esi-characters.write_contacts.v1",
  EVE_SCOPE_SET_VERSION: "1",
  DISCORD_CLIENT_ID: "d",
  DISCORD_CLIENT_SECRET: "d",
  DISCORD_BOT_TOKEN: "d",
  DISCORD_GUILD_ID: "1",
  DISCORD_ROLE_ID_FLYGD: "10",
  DISCORD_ROLE_ID_BLUE: "11",
  DISCORD_ROLE_ID_GREEN: "12",
  WANDERER_BASE_URL: "https://wanderer.example",
  WANDERER_API_KEY: "k",
  WANDERER_MAP_SLUG: "map",
  WANDERER_ACL_ID: "acl-1",
  STANDINGS_LABEL: "flygd",
  STANDINGS_VALUE: "5",
} as NodeJS.ProcessEnv;

describe("loadConfig", () => {
  it("parses a valid environment", () => {
    const c = loadConfig(validEnv);
    expect(c.allianceId).toBe(99000001);
    expect(c.bootstrapAdminCharacterIds).toEqual([90000001, 90000002]);
    expect(c.eveSso.scopes).toEqual([
      "esi-characters.read_contacts.v1",
      "esi-characters.write_contacts.v1",
    ]);
    expect(c.tokenEncryptionKey.length).toBe(32);
    expect(c.standings.value).toBe(5);
  });

  it("rejects a short encryption key", () => {
    expect(() =>
      loadConfig({ ...validEnv, TOKEN_ENCRYPTION_KEY: "c2hvcnQ=" }),
    ).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });

  it("rejects missing required vars", () => {
    const { DATABASE_URL: _omitted, ...rest } = validEnv;
    expect(() => loadConfig(rest as NodeJS.ProcessEnv)).toThrow();
  });

  it("rejects malformed or duplicate bootstrap admin ids", () => {
    expect(() =>
      loadConfig({ ...validEnv, BOOTSTRAP_ADMIN_CHARACTER_IDS: "123,abc" }),
    ).toThrow(/BOOTSTRAP_ADMIN_CHARACTER_IDS/);
    expect(() =>
      loadConfig({ ...validEnv, BOOTSTRAP_ADMIN_CHARACTER_IDS: "123,123" }),
    ).toThrow(/duplicates/);
  });
});
```

`tests/crypto.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decryptToken, encryptToken } from "@/lib/crypto";

const key = Buffer.alloc(32, 9);

describe("token crypto", () => {
  it("round-trips", () => {
    const blob = encryptToken("refresh-token-value", key);
    expect(blob).not.toContain("refresh-token-value");
    expect(decryptToken(blob, key)).toBe("refresh-token-value");
  });

  it("produces distinct ciphertexts (random IV)", () => {
    expect(encryptToken("x", key)).not.toBe(encryptToken("x", key));
  });

  it("fails on tampered ciphertext", () => {
    const blob = encryptToken("x", key);
    const parts = blob.split(".");
    parts[2] = parts[2].slice(0, -2) + "AA";
    expect(() => decryptToken(parts.join("."), key)).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/config.test.ts tests/crypto.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`src/config.ts`:

```ts
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
  WANDERER_MAP_SLUG: z.string().min(1),
  WANDERER_ACL_ID: z.string().min(1),
  STANDINGS_LABEL: z.string().min(1).default("flygd"),
  STANDINGS_VALUE: z.coerce.number().min(-10).max(10).default(5),
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
      mapSlug: e.WANDERER_MAP_SLUG,
      aclId: e.WANDERER_ACL_ID,
    },
    standings: { label: e.STANDINGS_LABEL, value: e.STANDINGS_VALUE },
  };
}

let cached: Config | undefined;
export function getConfig(): Config {
  cached ??= loadConfig();
  return cached;
}
```

`src/lib/crypto.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const b64u = (b: Buffer) => b.toString("base64url");

export function encryptToken(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [b64u(iv), b64u(cipher.getAuthTag()), b64u(ct)].join(".");
}

export function decryptToken(blob: string, key: Buffer): string {
  const [iv, tag, ct] = blob.split(".").map((p) => Buffer.from(p, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- tests/config.test.ts tests/crypto.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/lib/crypto.ts tests/config.test.ts tests/crypto.test.ts
git commit -m "feat: env config loader and AES-256-GCM token crypto"
```

---

### Task 3: Database schema and migrations

**Files:**
- Create: `src/db/schema.ts`, `src/db/index.ts`, `src/db/migrate.ts`, `drizzle.config.ts`, `tests/helpers/db.ts`
- Test: `tests/db-schema.test.ts`

**Interfaces:**
- Produces: Drizzle tables `account`, `character`, `discordLink`, `session`, `bootstrapAdminGrant`, `outbox`, `oauthTransaction`, `contactSyncState`, `syncRun`, `wandererAclObservation`, `auditLog` (exact columns below); `createDb(url): { db, pool }`; `type Db = ReturnType<typeof createDb>["db"]`; `type DbTx` (transaction handle — required by identity mutations) and `type Dbx = Db | DbTx` (reads / independent writes); test helper `setupTestDb(): Promise<{ db, pool, cleanup }>` that migrates `TEST_DATABASE_URL` and truncates all tables.

- [ ] **Step 1: Write failing test**

`tests/helpers/db.ts`:

```ts
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "@/db";

const TEST_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://authgd:authgd@localhost:5433/authgd_test";

export async function setupTestDb() {
  const { db, pool } = createDb(TEST_URL);
  await migrate(db, { migrationsFolder: "drizzle" });
  await db.execute(sql`
    TRUNCATE account, "character", discord_link, session, bootstrap_admin_grant,
      outbox, oauth_transaction, contact_sync_state, sync_run,
      wanderer_acl_observation, audit_log RESTART IDENTITY CASCADE
  `);
  return { db, pool, cleanup: () => pool.end() };
}
```

`tests/db-schema.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, character, discordLink } from "@/db/schema";
import { setupTestDb } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());

describe("schema", () => {
  it("creates an account with defaults and a character", async () => {
    const [acc] = await ctx.db.insert(account).values({}).returning();
    expect(acc.tier).toBe("green");
    expect(acc.tierLocked).toBe(false);
    expect(acc.status).toBe("active");
    expect(acc.isAdmin).toBe(false);

    const [ch] = await ctx.db
      .insert(character)
      .values({
        id: 90000001,
        accountId: acc.id,
        name: "Pilot One",
        ownerHash: "oh1",
        scopes: ["esi-characters.read_contacts.v1"],
        tokenStatus: "valid",
      })
      .returning();
    expect(ch.affiliationInvalid).toBe(false);
    expect(ch.tokenStatus).toBe("valid");
  });

  it("enforces unique discord_user_id", async () => {
    const [a1] = await ctx.db.insert(account).values({}).returning();
    const [a2] = await ctx.db.insert(account).values({}).returning();
    await ctx.db
      .insert(discordLink)
      .values({ accountId: a1.id, discordUserId: "duid-1" });
    await expect(
      ctx.db
        .insert(discordLink)
        .values({ accountId: a2.id, discordUserId: "duid-1" }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test -- tests/db-schema.test.ts`
Expected: FAIL (schema module missing).

- [ ] **Step 3: Implement schema, client, migrations**

`src/db/schema.ts`:

```ts
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const tierEnum = pgEnum("tier", ["flygd", "blue", "green"]);
export const accountStatusEnum = pgEnum("account_status", ["active", "cryo"]);
export const tokenStatusEnum = pgEnum("token_status", [
  "valid",
  "invalid",
  "needs_reauth",
  "missing",
]);
export const oauthIntentEnum = pgEnum("oauth_intent", [
  "login",
  "link-character",
  "link-discord",
]);
export const syncRunStatusEnum = pgEnum("sync_run_status", [
  "ok",
  "partial",
  "failed",
]);

export const account = pgTable("account", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  tier: tierEnum("tier").notNull().default("green"),
  tierChangedAt: timestamp("tier_changed_at", { withTimezone: true }),
  tierChangedBy: text("tier_changed_by"), // account uuid or "system"
  tierLocked: boolean("tier_locked").notNull().default(false),
  status: accountStatusEnum("status").notNull().default("active"),
  statusChangedAt: timestamp("status_changed_at", { withTimezone: true }),
  statusNote: text("status_note"),
  isAdmin: boolean("is_admin").notNull().default(false),
  mainCharacterId: bigint("main_character_id", { mode: "number" }),
});

export const character = pgTable(
  "character",
  {
    id: bigint("id", { mode: "number" }).primaryKey(), // EVE character id
    accountId: uuid("account_id")
      .notNull()
      .references(() => account.id),
    name: text("name").notNull(),
    corporationId: bigint("corporation_id", { mode: "number" }),
    allianceId: bigint("alliance_id", { mode: "number" }),
    affiliationCheckedAt: timestamp("affiliation_checked_at", { withTimezone: true }),
    affiliationInvalid: boolean("affiliation_invalid").notNull().default(false),
    ownerHash: text("owner_hash").notNull(),
    refreshTokenEnc: text("refresh_token_enc"),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    tokenStatus: tokenStatusEnum("token_status").notNull().default("missing"),
  },
  // target for the composite main-character FK on account
  (t) => [unique("character_id_account_uq").on(t.id, t.accountId)],
);

export const discordLink = pgTable("discord_link", {
  accountId: uuid("account_id")
    .primaryKey()
    .references(() => account.id),
  discordUserId: text("discord_user_id").notNull().unique(),
  linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(), // opaque random
  accountId: uuid("account_id")
    .notNull()
    .references(() => account.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

// Historical snapshot: account reference is nullable and detaches on account
// deletion so the consumed grant row survives forever (it must never be reusable).
export const bootstrapAdminGrant = pgTable("bootstrap_admin_grant", {
  characterId: bigint("character_id", { mode: "number" }).primaryKey(),
  ownerHash: text("owner_hash").notNull(),
  accountId: uuid("account_id").references(() => account.id, {
    onDelete: "set null",
  }),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
});

export const outbox = pgTable(
  "outbox",
  {
    id: serial("id").primaryKey(),
    payload: jsonb("payload")
      .$type<
        | { kind: "account"; accountId: string }
        | { kind: "discord-user"; discordUserId: string }
        | { kind: "all" }
      >()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  },
  // partial index on id restricted to undispatched rows — matches the
  // dispatcher's polling query and stays small as history grows
  (t) => [
    index("outbox_undispatched_idx")
      .on(t.id)
      .where(sql`${t.dispatchedAt} IS NULL`),
  ],
);

export const oauthTransaction = pgTable("oauth_transaction", {
  id: uuid("id").primaryKey().defaultRandom(),
  stateHash: text("state_hash").notNull().unique(),
  intent: oauthIntentEnum("intent").notNull(),
  sessionId: text("session_id"),
  accountId: uuid("account_id"),
  pkceVerifier: text("pkce_verifier").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
});

export const contactSyncState = pgTable("contact_sync_state", {
  characterId: bigint("character_id", { mode: "number" })
    .primaryKey()
    .references(() => character.id),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  lastResult: text("last_result"),
});

export const syncRun = pgTable("sync_run", {
  id: serial("id").primaryKey(),
  jobType: text("job_type").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  status: syncRunStatusEnum("status"),
  errorSummary: text("error_summary"),
  counts: jsonb("counts").$type<Record<string, number>>(),
});

export const wandererAclObservation = pgTable("wanderer_acl_observation", {
  characterId: bigint("character_id", { mode: "number" }).primaryKey(),
  role: text("role").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
});

export const auditLog = pgTable(
  "audit_log",
  {
    id: serial("id").primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actor: text("actor").notNull(), // account uuid or "system"
    action: text("action").notNull(),
    target: text("target").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>(),
  },
  (t) => [index("audit_log_at_idx").on(t.at)],
);
```

`src/db/index.ts`:

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export function createDb(url: string) {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export type Db = ReturnType<typeof createDb>["db"];
/** A live transaction handle. Identity mutations REQUIRE this (locks + deferred FK). */
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Either a pool client or a transaction — fine for reads and independent writes. */
export type Dbx = Db | DbTx;

let cached: ReturnType<typeof createDb> | undefined;
export function getDb(): Db {
  if (!cached) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL not set");
    cached = createDb(url);
  }
  return cached.db;
}
```

`drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgres://authgd:authgd@localhost:5433/authgd",
  },
});
```

`src/db/migrate.ts`:

```ts
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./index";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");
const { db, pool } = createDb(url);
await migrate(db, { migrationsFolder: "drizzle" });
await pool.end();
console.log("migrations applied");
```

- [ ] **Step 4: Generate migration, append the composite main-character FK, run tests**

Run: `npm run db:generate`
Expected: a SQL file appears in `drizzle/`.

Then create a follow-up custom migration `drizzle/0001_main_character_fk.sql` (register it by running `npx drizzle-kit generate --custom --name main_character_fk` and pasting the SQL into the generated file):

```sql
ALTER TABLE "account"
  ADD CONSTRAINT "account_main_character_fk"
  FOREIGN KEY ("main_character_id", "id")
  REFERENCES "character" ("id", "account_id")
  DEFERRABLE INITIALLY DEFERRED;
```

Deferred so account + character + main can be written in any order within one transaction; enforcement at commit guarantees the main exists **and belongs to that account**. Services always clear `main_character_id` (no-main rule) in the same transaction that deletes a character, satisfying the constraint at commit.

Run: `npm test -- tests/db-schema.test.ts`
Expected: tests PASS — including the invariant test below (add it to `tests/db-schema.test.ts`):

```ts
  it("rejects a main character belonging to another account", async () => {
    const [a1] = await ctx.db.insert(account).values({}).returning();
    const [a2] = await ctx.db.insert(account).values({}).returning();
    await ctx.db.insert(character).values({
      id: 90000042,
      accountId: a1.id,
      name: "Owned by a1",
      ownerHash: "oh",
      scopes: [],
      tokenStatus: "missing",
    });
    await expect(
      ctx.db.transaction(async (tx) => {
        await tx
          .update(account)
          .set({ mainCharacterId: 90000042 })
          .where(eq(account.id, a2.id));
      }),
    ).rejects.toThrow();
  });
```

(add `import { eq } from "drizzle-orm"` to that test file).

- [ ] **Step 5: Commit**

```bash
git add src/db drizzle drizzle.config.ts tests/helpers/db.ts tests/db-schema.test.ts
git commit -m "feat: full database schema, client, and migrations"
```

---

### Task 4: Audit log and session services

**Files:**
- Create: `src/services/audit.ts`, `src/services/session.ts`
- Test: `tests/session.test.ts`

**Interfaces:**
- Consumes: `Dbx`, schema tables from Task 3.
- Produces: `logAudit(dbx: Dbx, entry: { actor: string; action: string; target: string; details?: Record<string, unknown> }): Promise<void>`; `createSession(dbx, accountId: string): Promise<string>` (returns opaque id, 30-day expiry); `getSessionAccount(dbx, sessionId: string): Promise<{ accountId: string } | null>` (null when missing/expired; touches `last_seen_at` and account `last_login_at` at most hourly); `revokeAccountSessions(dbx, accountId: string): Promise<void>`.

- [ ] **Step 1: Write failing test**

`tests/session.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, session } from "@/db/schema";
import { createSession, getSessionAccount, revokeAccountSessions } from "@/services/session";
import { setupTestDb } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());

describe("sessions", () => {
  it("creates, resolves, and revokes sessions", async () => {
    const [acc] = await ctx.db.insert(account).values({}).returning();
    const sid = await createSession(ctx.db, acc.id);
    expect(sid.length).toBeGreaterThanOrEqual(32);

    const resolved = await getSessionAccount(ctx.db, sid);
    expect(resolved?.accountId).toBe(acc.id);

    await revokeAccountSessions(ctx.db, acc.id);
    expect(await getSessionAccount(ctx.db, sid)).toBeNull();
  });

  it("rejects expired sessions", async () => {
    const [acc] = await ctx.db.insert(account).values({}).returning();
    const sid = await createSession(ctx.db, acc.id);
    await ctx.db
      .update(session)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(session.id, sid));
    expect(await getSessionAccount(ctx.db, sid)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test -- tests/session.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`src/services/audit.ts`:

```ts
import type { Dbx } from "@/db";
import { auditLog } from "@/db/schema";

export async function logAudit(
  dbx: Dbx,
  entry: {
    actor: string;
    action: string;
    target: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await dbx.insert(auditLog).values(entry);
}
```

`src/services/session.ts`:

```ts
import { randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { Dbx } from "@/db";
import { account, session } from "@/db/schema";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export async function createSession(dbx: Dbx, accountId: string): Promise<string> {
  const id = randomBytes(32).toString("base64url");
  await dbx.insert(session).values({
    id,
    accountId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  await dbx
    .update(account)
    .set({ lastLoginAt: new Date() })
    .where(eq(account.id, accountId));
  return id;
}

export async function getSessionAccount(
  dbx: Dbx,
  sessionId: string,
): Promise<{ accountId: string } | null> {
  const rows = await dbx
    .select()
    .from(session)
    .where(and(eq(session.id, sessionId), gt(session.expiresAt, new Date())));
  const row = rows[0];
  if (!row) return null;
  if (Date.now() - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await dbx
      .update(session)
      .set({ lastSeenAt: new Date() })
      .where(eq(session.id, sessionId));
  }
  return { accountId: row.accountId };
}

export async function revokeAccountSessions(
  dbx: Dbx,
  accountId: string,
): Promise<void> {
  await dbx.delete(session).where(eq(session.accountId, accountId));
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npm test -- tests/session.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/audit.ts src/services/session.ts tests/session.test.ts
git commit -m "feat: audit log helper and server-side sessions"
```

---

### Task 5: OAuth transaction service

**Files:**
- Create: `src/services/oauth-tx.ts`
- Test: `tests/oauth-tx.test.ts`

**Interfaces:**
- Consumes: `Dbx`, `oauthTransaction` table.
- Produces: `createOauthTransaction(dbx, input: { intent: "login" | "link-character" | "link-discord"; sessionId?: string; accountId?: string }): Promise<{ state: string; codeVerifier: string; codeChallenge: string }>` — state is random, stored only as SHA-256 hash; expiry 10 min; PKCE verifier stored, S256 challenge returned. `consumeOauthTransaction(dbx, state: string, expectedIntents: Array<"login" | "link-character" | "link-discord">): Promise<{ intent; sessionId: string | null; accountId: string | null; pkceVerifier: string } | null>` — single-use (sets `consumed_at` atomically), null when unknown/expired/already consumed **or when the intent is not in `expectedIntents`** — the intent filter is part of the UPDATE's WHERE clause, so a transaction presented to the wrong callback is rejected *without being consumed* and remains usable by its real callback.

- [ ] **Step 1: Write failing test**

`tests/oauth-tx.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { oauthTransaction } from "@/db/schema";
import { consumeOauthTransaction, createOauthTransaction } from "@/services/oauth-tx";
import { setupTestDb } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());

describe("oauth transactions", () => {
  it("round-trips and is single-use", async () => {
    const tx = await createOauthTransaction(ctx.db, { intent: "login" });
    expect(tx.codeChallenge).not.toBe(tx.codeVerifier);

    const consumed = await consumeOauthTransaction(ctx.db, tx.state, ["login"]);
    expect(consumed?.intent).toBe("login");
    expect(consumed?.pkceVerifier).toBe(tx.codeVerifier);

    // replay rejected
    expect(await consumeOauthTransaction(ctx.db, tx.state, ["login"])).toBeNull();
  });

  it("does not store raw state", async () => {
    const tx = await createOauthTransaction(ctx.db, { intent: "login" });
    const rows = await ctx.db.select().from(oauthTransaction);
    expect(rows.some((r) => r.stateHash === tx.state)).toBe(false);
    await consumeOauthTransaction(ctx.db, tx.state, ["login"]);
  });

  it("rejects expired transactions", async () => {
    const tx = await createOauthTransaction(ctx.db, { intent: "login" });
    await ctx.db
      .update(oauthTransaction)
      .set({ expiresAt: new Date(Date.now() - 1000) });
    expect(await consumeOauthTransaction(ctx.db, tx.state, ["login"])).toBeNull();
  });

  it("rejects unknown state", async () => {
    expect(await consumeOauthTransaction(ctx.db, "nope", ["login"])).toBeNull();
  });

  it("leaves the transaction unconsumed when the intent does not match", async () => {
    const tx = await createOauthTransaction(ctx.db, { intent: "link-discord" });
    expect(await consumeOauthTransaction(ctx.db, tx.state, ["login"])).toBeNull();
    // still consumable by the right callback
    expect(
      await consumeOauthTransaction(ctx.db, tx.state, ["link-discord"]),
    ).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test -- tests/oauth-tx.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/services/oauth-tx.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import type { Dbx } from "@/db";
import { oauthTransaction } from "@/db/schema";

const TTL_MS = 10 * 60 * 1000;

const sha256b64u = (s: string) =>
  createHash("sha256").update(s).digest("base64url");

export async function createOauthTransaction(
  dbx: Dbx,
  input: {
    intent: "login" | "link-character" | "link-discord";
    sessionId?: string;
    accountId?: string;
  },
) {
  const state = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  await dbx.insert(oauthTransaction).values({
    stateHash: sha256b64u(state),
    intent: input.intent,
    sessionId: input.sessionId ?? null,
    accountId: input.accountId ?? null,
    pkceVerifier: codeVerifier,
    expiresAt: new Date(Date.now() + TTL_MS),
  });
  return { state, codeVerifier, codeChallenge: sha256b64u(codeVerifier) };
}

export async function consumeOauthTransaction(
  dbx: Dbx,
  state: string,
  expectedIntents: Array<"login" | "link-character" | "link-discord">,
) {
  const rows = await dbx
    .update(oauthTransaction)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(oauthTransaction.stateHash, sha256b64u(state)),
        inArray(oauthTransaction.intent, expectedIntents),
        isNull(oauthTransaction.consumedAt),
        gt(oauthTransaction.expiresAt, new Date()),
      ),
    )
    .returning();
  const row = rows[0];
  if (!row) return null;
  return {
    intent: row.intent,
    sessionId: row.sessionId,
    accountId: row.accountId,
    pkceVerifier: row.pkceVerifier,
  };
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npm test -- tests/oauth-tx.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/oauth-tx.ts tests/oauth-tx.test.ts
git commit -m "feat: durable single-use OAuth transactions with PKCE"
```

---

### Task 6: EVE SSO client (authorize URL, token exchange, JWT verification)

**Files:**
- Create: `src/lib/esi/sso.ts`
- Test: `tests/eve-sso.test.ts`

**Interfaces:**
- Consumes: `Config["eveSso"]`, `Config["appBaseUrl"]`.
- Produces:
  - `buildEveAuthorizeUrl(cfg: Config, state: string, codeChallenge: string): string` — `https://login.eveonline.com/v2/oauth/authorize` with `response_type=code`, `redirect_uri=${appBaseUrl}/auth/eve/callback`, `client_id`, `scope` (space-joined), `state`, `code_challenge`, `code_challenge_method=S256`.
  - `exchangeEveCode(cfg: Config, code: string, codeVerifier: string, fetchImpl?: typeof fetch): Promise<{ accessToken: string; refreshToken: string }>` — POST `https://login.eveonline.com/v2/oauth/token` (Basic auth, `grant_type=authorization_code`, `code_verifier`). Throws `EveSsoError` with `oauthError` field on error responses.
  - `verifyEveAccessToken(accessToken: string, getKey?: JWTVerifyGetKey): Promise<EveIdentity>` where `EveIdentity = { characterId: number; characterName: string; ownerHash: string; scopes: string[] }` — verifies signature via EVE JWKS (`https://login.eveonline.com/oauth/jwks`), issuer `https://login.eveonline.com`, audience `EVE Online`; parses `sub: "CHARACTER:EVE:<id>"`, `name`, `owner`, `scp` (string or array).
  - `refreshEveToken(cfg: Config, refreshToken: string, fetchImpl?: typeof fetch): Promise<{ accessToken: string; refreshToken: string }>` (same error type; used by Plan 2, defined here).
  - `class EveSsoError extends Error { oauthError?: string; status?: number }`

- [ ] **Step 1: Write failing test**

`tests/eve-sso.test.ts`:

```ts
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { createLocalJWKSet } from "jose";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@/config";
import {
  EveSsoError,
  buildEveAuthorizeUrl,
  exchangeEveCode,
  verifyEveAccessToken,
} from "@/lib/esi/sso";

const cfg = loadConfig({
  ...process.env,
  DATABASE_URL: "postgres://x/y",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  APP_BASE_URL: "https://auth.example",
  ALLIANCE_ID: "99000001",
  EVE_SSO_CLIENT_ID: "client-id",
  EVE_SSO_CLIENT_SECRET: "client-secret",
  EVE_SSO_SCOPES: "esi-characters.read_contacts.v1",
  DISCORD_CLIENT_ID: "d",
  DISCORD_CLIENT_SECRET: "d",
  DISCORD_BOT_TOKEN: "d",
  DISCORD_GUILD_ID: "1",
  DISCORD_ROLE_ID_FLYGD: "10",
  DISCORD_ROLE_ID_BLUE: "11",
  DISCORD_ROLE_ID_GREEN: "12",
  WANDERER_BASE_URL: "https://w.example",
  WANDERER_API_KEY: "k",
  WANDERER_MAP_SLUG: "m",
  WANDERER_ACL_ID: "a",
} as NodeJS.ProcessEnv);

describe("buildEveAuthorizeUrl", () => {
  it("contains all required params", () => {
    const url = new URL(buildEveAuthorizeUrl(cfg, "st4te", "ch4llenge"));
    expect(url.origin + url.pathname).toBe(
      "https://login.eveonline.com/v2/oauth/authorize",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://auth.example/auth/eve/callback",
    );
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("state")).toBe("st4te");
    expect(url.searchParams.get("code_challenge")).toBe("ch4llenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("esi-characters.read_contacts.v1");
  });
});

describe("exchangeEveCode", () => {
  it("posts code and returns tokens", async () => {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = new URLSearchParams(init?.body as string);
      expect(String(input)).toBe("https://login.eveonline.com/v2/oauth/token");
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("the-code");
      expect(body.get("code_verifier")).toBe("the-verifier");
      return new Response(
        JSON.stringify({ access_token: "at", refresh_token: "rt" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const r = await exchangeEveCode(cfg, "the-code", "the-verifier", fetchImpl);
    expect(r).toEqual({ accessToken: "at", refreshToken: "rt" });
  });

  it("throws EveSsoError with oauthError on failure", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
      })) as typeof fetch;
    await expect(
      exchangeEveCode(cfg, "c", "v", fetchImpl),
    ).rejects.toMatchObject({ oauthError: "invalid_grant" });
  });
});

describe("verifyEveAccessToken", () => {
  it("verifies a signed token and extracts identity", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: "RS256" }] });
    const token = await new SignJWT({
      name: "Pilot One",
      owner: "owner-hash-1",
      scp: ["esi-characters.read_contacts.v1"],
    })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("https://login.eveonline.com")
      .setAudience("EVE Online")
      .setSubject("CHARACTER:EVE:90000001")
      .setExpirationTime("5m")
      .sign(privateKey);

    const id = await verifyEveAccessToken(token, jwks);
    expect(id).toEqual({
      characterId: 90000001,
      characterName: "Pilot One",
      ownerHash: "owner-hash-1",
      scopes: ["esi-characters.read_contacts.v1"],
    });
  });

  it("fails closed on missing owner claim", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: "RS256" }] });
    const token = await new SignJWT({ name: "Pilot One" }) // no owner
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("https://login.eveonline.com")
      .setAudience("EVE Online")
      .setSubject("CHARACTER:EVE:90000001")
      .setExpirationTime("5m")
      .sign(privateKey);
    await expect(verifyEveAccessToken(token, jwks)).rejects.toThrow(/owner/);
  });
});

describe("token response validation", () => {
  it("fails closed when the token response omits tokens", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ access_token: "at" }), {
        status: 200,
      })) as typeof fetch; // refresh_token missing
    await expect(exchangeEveCode(cfg, "c", "v", fetchImpl)).rejects.toThrow(
      /missing tokens/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test -- tests/eve-sso.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/lib/esi/sso.ts`:

```ts
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Config } from "@/config";

const AUTHORIZE_URL = "https://login.eveonline.com/v2/oauth/authorize";
const TOKEN_URL = "https://login.eveonline.com/v2/oauth/token";
const JWKS_URL = "https://login.eveonline.com/oauth/jwks";
const ISSUER = "https://login.eveonline.com";
const AUDIENCE = "EVE Online";

export class EveSsoError extends Error {
  oauthError?: string;
  status?: number;
  constructor(message: string, opts: { oauthError?: string; status?: number } = {}) {
    super(message);
    this.oauthError = opts.oauthError;
    this.status = opts.status;
  }
}

export interface EveIdentity {
  characterId: number;
  characterName: string;
  ownerHash: string;
  scopes: string[];
}

export function buildEveAuthorizeUrl(
  cfg: Config,
  state: string,
  codeChallenge: string,
): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", `${cfg.appBaseUrl}/auth/eve/callback`);
  url.searchParams.set("client_id", cfg.eveSso.clientId);
  url.searchParams.set("scope", cfg.eveSso.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

async function tokenRequest(
  cfg: Config,
  body: URLSearchParams,
  fetchImpl: typeof fetch,
): Promise<{ accessToken: string; refreshToken: string }> {
  const basic = Buffer.from(
    `${cfg.eveSso.clientId}:${cfg.eveSso.clientSecret}`,
  ).toString("base64");
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new EveSsoError(`EVE SSO token request failed (${res.status})`, {
      oauthError: typeof json.error === "string" ? json.error : undefined,
      status: res.status,
    });
  }
  // fail closed: these values feed ownership logic and token storage
  const accessToken = json.access_token;
  const refreshToken = json.refresh_token;
  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    typeof refreshToken !== "string" ||
    refreshToken.length === 0
  ) {
    throw new EveSsoError("EVE SSO token response missing tokens");
  }
  return { accessToken, refreshToken };
}

export function exchangeEveCode(
  cfg: Config,
  code: string,
  codeVerifier: string,
  fetchImpl: typeof fetch = fetch,
) {
  return tokenRequest(
    cfg,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
    }),
    fetchImpl,
  );
}

export function refreshEveToken(
  cfg: Config,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
) {
  return tokenRequest(
    cfg,
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
    fetchImpl,
  );
}

let remoteJwks: JWTVerifyGetKey | undefined;

export async function verifyEveAccessToken(
  accessToken: string,
  getKey?: JWTVerifyGetKey,
): Promise<EveIdentity> {
  remoteJwks ??= createRemoteJWKSet(new URL(JWKS_URL));
  const { payload } = await jwtVerify(accessToken, getKey ?? remoteJwks, {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  const sub = String(payload.sub ?? "");
  const match = /^CHARACTER:EVE:(\d+)$/.exec(sub);
  if (!match) throw new EveSsoError(`unexpected subject: ${sub}`);
  // fail closed: ownerHash drives transfer reclaim — never coerce missing claims
  const { name, owner, scp } = payload as {
    name?: unknown;
    owner?: unknown;
    scp?: unknown;
  };
  if (typeof name !== "string" || name.length === 0) {
    throw new EveSsoError("EVE JWT missing name claim");
  }
  if (typeof owner !== "string" || owner.length === 0) {
    throw new EveSsoError("EVE JWT missing owner claim");
  }
  return {
    characterId: Number(match[1]),
    characterName: name,
    ownerHash: owner,
    scopes: Array.isArray(scp)
      ? scp.map(String)
      : typeof scp === "string"
        ? [scp]
        : [],
  };
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npm test -- tests/eve-sso.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/esi/sso.ts tests/eve-sso.test.ts
git commit -m "feat: EVE SSO client with PKCE and JWT verification"
```

---

### Task 7: Outbox writer and error classification core

**Files:**
- Create: `src/services/outbox.ts`, `src/core/errors.ts`
- Test: `tests/outbox.test.ts`, `tests/errors.test.ts`

**Interfaces:**
- Produces: `enqueueSync(dbx: Dbx, payload: OutboxPayload): Promise<void>` where `OutboxPayload = { kind: "account"; accountId } | { kind: "discord-user"; discordUserId } | { kind: "all" }` (the `discord-user` variant tells Plan 2's Discord job to strip managed roles from a user no longer linked anywhere); `takeUndispatched(dbx: Dbx, limit?: number): Promise<Array<{ id: number; payload: OutboxPayload }>>` and `markDispatched(dbx: Dbx, ids: number[]): Promise<void>` (consumed by Plan 2's dispatcher); `type OutboxPayload`.
- Produces actionable categories, not just a binary:
  - `type OAuthErrorClass = "permanent" | "transient"` and `classifyOAuthError(oauthError: string | undefined, status: number | undefined): OAuthErrorClass` — `invalid_grant`/`invalid_token`/`unauthorized_client`/`access_denied` → permanent; **`temporarily_unavailable` and `server_error` are transient even with a 400/status body**; unknown error strings with status 400/401 → permanent; everything else (420/429/5xx/network/undefined) → transient.
  - `type EsiErrorClass = "needs_reauth" | "permanent" | "transient"` and `classifyEsiError(status: number, body?: { error?: string }): EsiErrorClass` — 403 whose body error mentions scope/token authorization (`/scope|token|authorization/i`) → `needs_reauth`; other 403 and 400/404 → permanent; 420/429/5xx → transient; other 4xx → permanent.

- [ ] **Step 1: Write failing tests**

`tests/errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { classifyEsiError, classifyOAuthError } from "@/core/errors";

describe("classifyOAuthError", () => {
  it("marks invalid_grant permanent", () => {
    expect(classifyOAuthError("invalid_grant", 400)).toBe("permanent");
  });
  it("keeps temporarily_unavailable/server_error transient even at 400", () => {
    expect(classifyOAuthError("temporarily_unavailable", 400)).toBe("transient");
    expect(classifyOAuthError("server_error", 400)).toBe("transient");
  });
  it("marks unknown 400-error bodies permanent", () => {
    expect(classifyOAuthError("weird_new_error", 400)).toBe("permanent");
  });
  it("marks rate limiting transient", () => {
    expect(classifyOAuthError(undefined, 429)).toBe("transient");
  });
  it("marks server errors transient", () => {
    expect(classifyOAuthError(undefined, 502)).toBe("transient");
  });
  it("marks network failure (no status) transient", () => {
    expect(classifyOAuthError(undefined, undefined)).toBe("transient");
  });
});

describe("classifyEsiError", () => {
  it("maps 403 missing-scope to needs_reauth", () => {
    expect(
      classifyEsiError(403, { error: "token is not valid for scope" }),
    ).toBe("needs_reauth");
  });
  it("maps other 403 to permanent", () => {
    expect(classifyEsiError(403, { error: "forbidden" })).toBe("permanent");
  });
  it.each([
    [400, "permanent"],
    [404, "permanent"],
    [420, "transient"],
    [429, "transient"],
    [500, "transient"],
    [503, "transient"],
  ])("status %d → %s", (status, expected) => {
    expect(classifyEsiError(status as number)).toBe(expected);
  });
});
```

`tests/outbox.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enqueueSync, markDispatched, takeUndispatched } from "@/services/outbox";
import { setupTestDb } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());

describe("outbox", () => {
  it("enqueues, takes, and marks dispatched", async () => {
    await enqueueSync(ctx.db, { kind: "all" });
    await enqueueSync(ctx.db, { kind: "account", accountId: "00000000-0000-0000-0000-000000000001" });

    const taken = await takeUndispatched(ctx.db);
    expect(taken).toHaveLength(2);

    await markDispatched(ctx.db, taken.map((t) => t.id));
    expect(await takeUndispatched(ctx.db)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/errors.test.ts tests/outbox.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/core/errors.ts`:

```ts
export type OAuthErrorClass = "permanent" | "transient";
export type EsiErrorClass = "needs_reauth" | "permanent" | "transient";

const PERMANENT_OAUTH_ERRORS = new Set([
  "invalid_grant",
  "invalid_token",
  "unauthorized_client",
  "access_denied",
]);
const TRANSIENT_OAUTH_ERRORS = new Set(["temporarily_unavailable", "server_error"]);

export function classifyOAuthError(
  oauthError: string | undefined,
  status: number | undefined,
): OAuthErrorClass {
  if (oauthError && TRANSIENT_OAUTH_ERRORS.has(oauthError)) return "transient";
  if (oauthError && PERMANENT_OAUTH_ERRORS.has(oauthError)) return "permanent";
  if (oauthError && (status === 400 || status === 401)) return "permanent";
  return "transient";
}

export function classifyEsiError(
  status: number,
  body?: { error?: string },
): EsiErrorClass {
  if (status === 420 || status === 429) return "transient";
  if (status >= 500) return "transient";
  if (status === 403 && body?.error && /scope|token|authorization/i.test(body.error)) {
    return "needs_reauth";
  }
  return "permanent";
}
```

`src/services/outbox.ts`:

```ts
import { inArray, isNull } from "drizzle-orm";
import type { Dbx } from "@/db";
import { outbox } from "@/db/schema";

export type OutboxPayload =
  | { kind: "account"; accountId: string }
  | { kind: "discord-user"; discordUserId: string } // Plan 2: strip managed roles from an unlinked Discord user
  | { kind: "all" };

export async function enqueueSync(dbx: Dbx, payload: OutboxPayload): Promise<void> {
  await dbx.insert(outbox).values({ payload });
}

export async function takeUndispatched(
  dbx: Dbx,
  limit = 100,
): Promise<Array<{ id: number; payload: OutboxPayload }>> {
  const rows = await dbx
    .select()
    .from(outbox)
    .where(isNull(outbox.dispatchedAt))
    .orderBy(outbox.id)
    .limit(limit);
  return rows.map((r) => ({ id: r.id, payload: r.payload }));
}

export async function markDispatched(dbx: Dbx, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await dbx
    .update(outbox)
    .set({ dispatchedAt: new Date() })
    .where(inArray(outbox.id, ids));
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- tests/errors.test.ts tests/outbox.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/errors.ts src/services/outbox.ts tests/errors.test.ts tests/outbox.test.ts
git commit -m "feat: outbox writer and transient/permanent error classification"
```

---

### Task 8: Account service — creation, linking, reclaim, no-main rule, bootstrap admin

This is the heart of Plan 1. **Every function here takes `DbTx` (not `Dbx`)** and must be called inside `db.transaction()` — the deferred main-character FK and all `FOR UPDATE` locks only work there, and the compiler enforces it. Lock order everywhere: character row(s) first, then account row(s).

**Files:**
- Create: `src/services/accounts.ts`
- Test: `tests/accounts.test.ts`

**Interfaces:**
- Consumes: `Dbx`, schema, `logAudit`, `enqueueSync`, `revokeAccountSessions`, `encryptToken`, `Config`.
- Produces:
  - `type EveCallbackCharacter = { characterId: number; characterName: string; ownerHash: string; scopes: string[]; refreshToken: string }`
  - Token status on every write is computed, never assumed: `valid` when granted scopes ⊇ `cfg.eveSso.scopes`, else `needs_reauth`.
  - Character-ownership reads inside these functions use `SELECT … FOR UPDATE` on the character row, so concurrent callbacks for the same character serialize instead of acting on stale ownership.
  - `handleEveLogin(dbx, cfg: Config, ch: EveCallbackCharacter): Promise<{ accountId: string }>` — existing character + same ownerHash → **re-auth in place**: refresh token/scopes, recompute token status, audit `character.reauthed`, outbox row, return its account. Existing character + different ownerHash → **transfer reclaim**: unlink from old account (apply no-main rule; revoke old account sessions), then create a new account for the character. Unknown character → create account (tier green, unlocked, audit `account.created`, outbox row) and link. Both the create path and the link path apply `maybeGrantBootstrapAdmin` internally — callers cannot forget it.
  - `linkCharacter(dbx, cfg, accountId: string, ch: EveCallbackCharacter): Promise<{ ok: true } | { ok: false; error: "already_linked" }>` — own character → re-auth in place (audit + outbox as above). Linked elsewhere + same ownerHash → `already_linked` error. Linked elsewhere + different ownerHash → reclaim then link to this account. New → link (first character of the account also becomes main), audit `character.linked`, outbox row, then `maybeGrantBootstrapAdmin` internally.
  - `unlinkCharacter(dbx, cfg, actor: string, characterId: number, opts?: { revokeSessions?: boolean }): Promise<void>` — deletes token/link (row removed along with its `contact_sync_state`); if it was the main applies **no-main rule**: `mainCharacterId = null`, tier → green unless `tierLocked` (audit `tier.changed` with cause), outbox row; audit `character.unlinked`.
  - `setMainCharacter(dbx, accountId: string, characterId: number): Promise<void>` — validates ownership, sets main, audit `account.main_changed`, outbox row.
  - `maybeGrantBootstrapAdmin(dbx, cfg, accountId: string, ch: { characterId: number; ownerHash: string }): Promise<boolean>` — grants once per character ever (insert into `bootstrap_admin_grant` with `onConflictDoNothing`; only a successful insert grants), audit `admin.bootstrap_granted`.
  - `demoteAdmin(dbx, actor: string, accountId: string): Promise<{ ok: boolean; error?: "last_admin" }>` — refuses when target is the only admin. Race-safe: locks all admin rows (`FOR UPDATE`) before counting, so two admins concurrently demoting each other cannot both succeed.
  - **Lost-last-admin recovery (documented behavior, not code):** reclaim never clears `is_admin` — a demoted-by-transfer admin account keeps its flag and can log in with any remaining character. If an admin's *only* character is reclaimed, recovery is operational: add a new character id to `BOOTSTRAP_ADMIN_CHARACTER_IDS` and have them log in fresh (new account, new one-time grant).

- [ ] **Step 1: Write failing tests**

`tests/accounts.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "@/config";
import { account, auditLog, bootstrapAdminGrant, character, outbox, session } from "@/db/schema";
import {
  demoteAdmin,
  handleEveLogin,
  linkCharacter,
  maybeGrantBootstrapAdmin,
  setMainCharacter,
  unlinkCharacter,
  type EveCallbackCharacter,
} from "@/services/accounts";
import { createSession, getSessionAccount } from "@/services/session";
import { setupTestDb } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
let cfg: Config;

const ch = (over: Partial<EveCallbackCharacter> = {}): EveCallbackCharacter => ({
  characterId: 90000001,
  characterName: "Pilot One",
  ownerHash: "oh-1",
  scopes: ["esi-characters.read_contacts.v1", "esi-characters.write_contacts.v1"],
  refreshToken: "rt-1",
  ...over,
});

beforeAll(async () => {
  ctx = await setupTestDb();
  cfg = loadConfig({
    ...process.env,
    DATABASE_URL: "postgres://x/y",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    APP_BASE_URL: "http://localhost:3000",
    ALLIANCE_ID: "99000001",
    BOOTSTRAP_ADMIN_CHARACTER_IDS: "90000009",
    EVE_SSO_CLIENT_ID: "c",
    EVE_SSO_CLIENT_SECRET: "s",
    EVE_SSO_SCOPES: "esi-characters.read_contacts.v1 esi-characters.write_contacts.v1",
    DISCORD_CLIENT_ID: "d",
    DISCORD_CLIENT_SECRET: "d",
    DISCORD_BOT_TOKEN: "d",
    DISCORD_GUILD_ID: "1",
    DISCORD_ROLE_ID_FLYGD: "10",
    DISCORD_ROLE_ID_BLUE: "11",
    DISCORD_ROLE_ID_GREEN: "12",
    WANDERER_BASE_URL: "https://w.example",
    WANDERER_API_KEY: "k",
    WANDERER_MAP_SLUG: "m",
    WANDERER_ACL_ID: "a",
  } as NodeJS.ProcessEnv);
});
beforeEach(async () => {
  const { sql } = await import("drizzle-orm");
  await ctx.db.execute(sql`
    TRUNCATE account, "character", discord_link, session, bootstrap_admin_grant,
      outbox, oauth_transaction, contact_sync_state, sync_run,
      wanderer_acl_observation, audit_log RESTART IDENTITY CASCADE
  `);
});
afterAll(() => ctx.cleanup());

// Identity mutations require a transaction (DbTx); these helpers wrap each call.
const login = (c: EveCallbackCharacter) =>
  ctx.db.transaction((tx) => handleEveLogin(tx, cfg, c));
const link = (accountId: string, c: EveCallbackCharacter) =>
  ctx.db.transaction((tx) => linkCharacter(tx, cfg, accountId, c));
const unlink = (actor: string, characterId: number) =>
  ctx.db.transaction((tx) => unlinkCharacter(tx, cfg, actor, characterId));
const setMain = (accountId: string, characterId: number) =>
  ctx.db.transaction((tx) => setMainCharacter(tx, accountId, characterId));
const demote = (actor: string, accountId: string) =>
  ctx.db.transaction((tx) => demoteAdmin(tx, actor, accountId));

describe("handleEveLogin", () => {
  it("creates a pessimistic green account with outbox + audit", async () => {
    const { accountId } = await login(ch());
    const [acc] = await ctx.db.select().from(account).where(eq(account.id, accountId));
    expect(acc.tier).toBe("green");
    expect(acc.tierLocked).toBe(false);
    expect(acc.mainCharacterId).toBe(90000001);

    const [chr] = await ctx.db.select().from(character);
    expect(chr.tokenStatus).toBe("valid");
    expect(chr.refreshTokenEnc).not.toBe("rt-1"); // encrypted

    const boxes = await ctx.db.select().from(outbox);
    expect(boxes.map((b) => b.payload)).toContainEqual({
      kind: "account",
      accountId,
    });
    const audits = await ctx.db.select().from(auditLog);
    expect(audits.some((a) => a.action === "account.created")).toBe(true);
  });

  it("logs into the existing account on re-auth with same owner", async () => {
    const first = await login(ch());
    const again = await login(ch({ refreshToken: "rt-2" }));
    expect(again.accountId).toBe(first.accountId);
    expect((await ctx.db.select().from(account))).toHaveLength(1);
  });

  it("reclaims a sold character: unlinks, demotes old account, revokes its sessions", async () => {
    const old = await login(ch());
    // make old account flygd so we can observe demotion
    await ctx.db
      .update(account)
      .set({ tier: "flygd" })
      .where(eq(account.id, old.accountId));
    const sid = await createSession(ctx.db, old.accountId);

    const bought = await login(ch({ ownerHash: "oh-NEW" }));
    expect(bought.accountId).not.toBe(old.accountId);

    const [oldAcc] = await ctx.db.select().from(account).where(eq(account.id, old.accountId));
    expect(oldAcc.mainCharacterId).toBeNull();
    expect(oldAcc.tier).toBe("green");
    expect(await getSessionAccount(ctx.db, sid)).toBeNull();

    const [chr] = await ctx.db.select().from(character);
    expect(chr.accountId).toBe(bought.accountId);
    expect(chr.ownerHash).toBe("oh-NEW");
  });
});

describe("linkCharacter", () => {
  it("links an alt and rejects double-link with same owner", async () => {
    const a = await login(ch());
    const b = await login(ch({ characterId: 90000002, ownerHash: "oh-2", characterName: "Other" }));

    const alt = ch({ characterId: 90000003, characterName: "Alt", ownerHash: "oh-1" });
    expect(await link(a.accountId, alt)).toEqual({ ok: true });

    // same character, same owner, other account → rejected
    const res = await link(b.accountId, alt);
    expect(res).toEqual({ ok: false, error: "already_linked" });
  });

  it("does not demote a tier_locked account on main unlink", async () => {
    const a = await login(ch());
    await ctx.db
      .update(account)
      .set({ tier: "blue", tierLocked: true })
      .where(eq(account.id, a.accountId));
    await unlink("system", 90000001);
    const [acc] = await ctx.db.select().from(account);
    expect(acc.tier).toBe("blue");
    expect(acc.mainCharacterId).toBeNull();
  });
});

describe("transaction rollback", () => {
  it("leaves no partial state when the transaction throws after linking", async () => {
    const a = await login(ch());
    const auditCountBefore = (await ctx.db.select().from(auditLog)).length;
    const outboxCountBefore = (await ctx.db.select().from(outbox)).length;
    await expect(
      ctx.db.transaction(async (tx) => {
        await linkCharacter(tx, cfg, a.accountId, ch({ characterId: 90000050, characterName: "Doomed" }));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const chars = await ctx.db.select().from(character);
    expect(chars.map((c) => c.id)).toEqual([90000001]); // no orphan character
    expect(await ctx.db.select().from(auditLog)).toHaveLength(auditCountBefore);
    expect(await ctx.db.select().from(outbox)).toHaveLength(outboxCountBefore);
  });
});

describe("concurrent first login", () => {
  it("two simultaneous logins for one new character yield one account", async () => {
    const results = await Promise.all([login(ch()), login(ch())]);
    expect(results[0].accountId).toBe(results[1].accountId);
    expect(await ctx.db.select().from(account)).toHaveLength(1);
    expect(await ctx.db.select().from(character)).toHaveLength(1);
  });
});

describe("setMainCharacter", () => {
  it("sets main and writes an outbox row", async () => {
    const a = await login(ch());
    await link(a.accountId, ch({ characterId: 90000003, characterName: "Alt" }));
    await ctx.db.delete(outbox);
    await setMain(a.accountId, 90000003);
    const [acc] = await ctx.db.select().from(account);
    expect(acc.mainCharacterId).toBe(90000003);
    expect(await ctx.db.select().from(outbox)).toHaveLength(1);
  });

  it("rejects characters not on the account", async () => {
    const a = await login(ch());
    await expect(setMain(a.accountId, 99999999)).rejects.toThrow();
  });
});

describe("re-auth side effects", () => {
  it("audits, enqueues, and downgrades status when scopes shrink", async () => {
    const a = await login(ch());
    await ctx.db.delete(outbox);
    await login(
      ch({ refreshToken: "rt-2", scopes: ["esi-characters.read_contacts.v1"] }), // missing write scope
    );
    const [chr] = await ctx.db.select().from(character);
    expect(chr.tokenStatus).toBe("needs_reauth");
    expect(await ctx.db.select().from(outbox)).toHaveLength(1);
    const audits = await ctx.db.select().from(auditLog);
    expect(audits.some((x) => x.action === "character.reauthed")).toBe(true);
  });
});

describe("bootstrap admin", () => {
  it("grants on first login of a bootstrap character, never after transfer", async () => {
    const a = await login(ch({ characterId: 90000009, ownerHash: "oh-boss" }));
    const [acc] = await ctx.db.select().from(account).where(eq(account.id, a.accountId));
    expect(acc.isAdmin).toBe(true); // granted inside the service, no extra call

    // sold: new owner logs in → reclaim makes a new account; grant must NOT fire again
    const b = await login(ch({ characterId: 90000009, ownerHash: "oh-thief" }));
    const [bAcc] = await ctx.db.select().from(account).where(eq(account.id, b.accountId));
    expect(bAcc.isAdmin).toBe(false);
  });

  it("grants when a bootstrap character is linked as an alt", async () => {
    const a = await login(ch()); // non-bootstrap main
    let [acc] = await ctx.db.select().from(account).where(eq(account.id, a.accountId));
    expect(acc.isAdmin).toBe(false);
    await link(
      a.accountId,
      ch({ characterId: 90000009, ownerHash: "oh-1", characterName: "Boss Alt" }),
    );
    [acc] = await ctx.db.select().from(account).where(eq(account.id, a.accountId));
    expect(acc.isAdmin).toBe(true);
  });

  it("ignores non-bootstrap characters", async () => {
    const a = await login(ch());
    expect(
      await ctx.db.transaction((tx) =>
        maybeGrantBootstrapAdmin(tx, cfg, a.accountId, {
          characterId: 90000001,
          ownerHash: "oh-1",
        }),
      ),
    ).toBe(false);
  });
});

describe("demoteAdmin", () => {
  it("refuses to demote the last admin", async () => {
    const a = await login(ch());
    await ctx.db.update(account).set({ isAdmin: true }).where(eq(account.id, a.accountId));
    expect(await demote("system", a.accountId)).toEqual({
      ok: false,
      error: "last_admin",
    });
  });

  it("demotes when another admin exists", async () => {
    const a = await login(ch());
    const b = await login(ch({ characterId: 90000002, ownerHash: "oh-2", characterName: "B" }));
    await ctx.db.update(account).set({ isAdmin: true });
    expect(await demote("system", b.accountId)).toEqual({ ok: true });
  });

  it("never lets two concurrent demotions remove both admins", async () => {
    const a = await login(ch());
    const b = await login(ch({ characterId: 90000002, ownerHash: "oh-2", characterName: "B" }));
    await ctx.db.update(account).set({ isAdmin: true });

    const [r1, r2] = await Promise.all([
      ctx.db.transaction((tx) => demoteAdmin(tx, a.accountId, b.accountId)),
      ctx.db.transaction((tx) => demoteAdmin(tx, b.accountId, a.accountId)),
    ]);
    // exactly one demotion succeeds; at least one admin always remains
    expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1);
    const admins = await ctx.db.select().from(account).where(eq(account.isAdmin, true));
    expect(admins.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/accounts.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/services/accounts.ts`:

```ts
import { and, eq, sql } from "drizzle-orm";
import type { Config } from "@/config";
import type { DbTx } from "@/db";
import { account, bootstrapAdminGrant, character, contactSyncState } from "@/db/schema";
import { encryptToken } from "@/lib/crypto";
import { logAudit } from "@/services/audit";
import { enqueueSync } from "@/services/outbox";
import { revokeAccountSessions } from "@/services/session";

// LOCK ORDER (deadlock avoidance), applied top to bottom:
//   1. pg_advisory_xact_lock(characterId) — serializes even when no character
//      row exists yet (two first-logins for the same character cannot race).
//   2. character row(s) FOR UPDATE.
//   3. account row(s) FOR UPDATE, ALWAYS in sorted-id order when more than one
//      account is involved (opposite-direction transfers cannot deadlock).
// demoteAdmin locks account rows only.
export interface EveCallbackCharacter {
  characterId: number;
  characterName: string;
  ownerHash: string;
  scopes: string[];
  refreshToken: string;
}

/**
 * Transaction-scoped advisory lock on the character id. Unlike FOR UPDATE this
 * also serializes callers when NO row exists yet, so two concurrent first
 * logins for the same character cannot both take the insert path.
 */
async function lockCharacterId(dbx: DbTx, characterId: number) {
  await dbx.execute(sql`SELECT pg_advisory_xact_lock(${characterId})`);
}

/** Advisory lock + row lock, in that order. */
async function findCharacterForUpdate(dbx: DbTx, characterId: number) {
  await lockCharacterId(dbx, characterId);
  const rows = await dbx
    .select()
    .from(character)
    .where(eq(character.id, characterId))
    .for("update");
  return rows[0];
}

/** Lock several account rows deterministically (sorted id order). */
async function lockAccounts(dbx: DbTx, ids: string[]) {
  for (const id of [...new Set(ids)].sort()) {
    await dbx.select().from(account).where(eq(account.id, id)).for("update");
  }
}

function tokenFields(cfg: Config, ch: EveCallbackCharacter) {
  const hasAllScopes = cfg.eveSso.scopes.every((s) => ch.scopes.includes(s));
  return {
    name: ch.characterName,
    ownerHash: ch.ownerHash,
    refreshTokenEnc: encryptToken(ch.refreshToken, cfg.tokenEncryptionKey),
    scopes: ch.scopes,
    tokenStatus: (hasAllScopes ? "valid" : "needs_reauth") as
      | "valid"
      | "needs_reauth",
  };
}

/** Re-auth in place: refresh credentials + status, audit, and enqueue sync. */
async function reauthCharacter(
  dbx: DbTx,
  cfg: Config,
  accountId: string,
  ch: EveCallbackCharacter,
) {
  await dbx
    .update(character)
    .set(tokenFields(cfg, ch))
    .where(eq(character.id, ch.characterId));
  await logAudit(dbx, {
    actor: accountId,
    action: "character.reauthed",
    target: String(ch.characterId),
  });
  await enqueueSync(dbx, { kind: "account", accountId });
}

/** No-main rule: atomically clear main, demote unless locked, enqueue sync. */
async function applyNoMainRule(dbx: DbTx, accountId: string, cause: string) {
  const [acc] = await dbx
    .select()
    .from(account)
    .where(eq(account.id, accountId))
    .for("update");
  if (!acc) return;
  const demote = !acc.tierLocked && acc.tier !== "green";
  await dbx
    .update(account)
    .set({
      mainCharacterId: null,
      ...(demote
        ? { tier: "green" as const, tierChangedAt: new Date(), tierChangedBy: "system" }
        : {}),
    })
    .where(eq(account.id, accountId));
  if (demote) {
    await logAudit(dbx, {
      actor: "system",
      action: "tier.changed",
      target: accountId,
      details: { to: "green", cause },
    });
  }
  await enqueueSync(dbx, { kind: "account", accountId });
}

async function reclaimCharacter(
  dbx: DbTx,
  existing: { id: number; accountId: string },
) {
  const [oldAcc] = await dbx
    .select()
    .from(account)
    .where(eq(account.id, existing.accountId))
    .for("update");
  await dbx.delete(contactSyncState).where(eq(contactSyncState.characterId, existing.id));
  await dbx.delete(character).where(eq(character.id, existing.id));
  await logAudit(dbx, {
    actor: "system",
    action: "character.reclaimed",
    target: String(existing.id),
    details: { fromAccount: existing.accountId },
  });
  if (oldAcc?.mainCharacterId === existing.id) {
    await applyNoMainRule(dbx, existing.accountId, "character transferred");
  } else {
    await enqueueSync(dbx, { kind: "account", accountId: existing.accountId });
  }
  await revokeAccountSessions(dbx, existing.accountId);
}

async function createAccountWithCharacter(
  dbx: DbTx,
  cfg: Config,
  ch: EveCallbackCharacter,
): Promise<string> {
  const [acc] = await dbx
    .insert(account)
    .values({ tier: "green", mainCharacterId: ch.characterId })
    .returning();
  await dbx.insert(character).values({
    id: ch.characterId,
    accountId: acc.id,
    ...tokenFields(cfg, ch),
  });
  await logAudit(dbx, {
    actor: "system",
    action: "account.created",
    target: acc.id,
    details: { mainCharacterId: ch.characterId },
  });
  await enqueueSync(dbx, { kind: "account", accountId: acc.id });
  await maybeGrantBootstrapAdmin(dbx, cfg, acc.id, {
    characterId: ch.characterId,
    ownerHash: ch.ownerHash,
  });
  return acc.id;
}

export async function handleEveLogin(
  dbx: DbTx,
  cfg: Config,
  ch: EveCallbackCharacter,
): Promise<{ accountId: string }> {
  const existing = await findCharacterForUpdate(dbx, ch.characterId);
  if (existing && existing.ownerHash === ch.ownerHash) {
    await reauthCharacter(dbx, cfg, existing.accountId, ch);
    return { accountId: existing.accountId };
  }
  if (existing) {
    // sold character: owner-hash comparison precedes any rejection
    await reclaimCharacter(dbx, existing);
  }
  return { accountId: await createAccountWithCharacter(dbx, cfg, ch) };
}

export async function linkCharacter(
  dbx: DbTx,
  cfg: Config,
  accountId: string,
  ch: EveCallbackCharacter,
): Promise<{ ok: true } | { ok: false; error: "already_linked" }> {
  const existing = await findCharacterForUpdate(dbx, ch.characterId);
  if (existing) {
    if (existing.accountId === accountId) {
      await reauthCharacter(dbx, cfg, accountId, ch);
      return { ok: true };
    }
    if (existing.ownerHash === ch.ownerHash) {
      return { ok: false, error: "already_linked" };
    }
    // two accounts involved: lock both in sorted order before mutating
    await lockAccounts(dbx, [existing.accountId, accountId]);
    await reclaimCharacter(dbx, existing);
  }
  await dbx.insert(character).values({
    id: ch.characterId,
    accountId,
    ...tokenFields(cfg, ch),
  });
  const [acc] = await dbx
    .select()
    .from(account)
    .where(eq(account.id, accountId))
    .for("update");
  if (acc && acc.mainCharacterId === null) {
    await dbx
      .update(account)
      .set({ mainCharacterId: ch.characterId })
      .where(eq(account.id, accountId));
  }
  await logAudit(dbx, {
    actor: accountId,
    action: "character.linked",
    target: String(ch.characterId),
  });
  await enqueueSync(dbx, { kind: "account", accountId });
  await maybeGrantBootstrapAdmin(dbx, cfg, accountId, {
    characterId: ch.characterId,
    ownerHash: ch.ownerHash,
  });
  return { ok: true };
}

export async function unlinkCharacter(
  dbx: DbTx,
  cfg: Config,
  actor: string,
  characterId: number,
  opts: { revokeSessions?: boolean } = {},
): Promise<void> {
  const existing = await findCharacterForUpdate(dbx, characterId);
  if (!existing) return;
  await dbx.delete(contactSyncState).where(eq(contactSyncState.characterId, characterId));
  await dbx.delete(character).where(eq(character.id, characterId));
  await logAudit(dbx, {
    actor,
    action: "character.unlinked",
    target: String(characterId),
  });
  const [acc] = await dbx
    .select()
    .from(account)
    .where(eq(account.id, existing.accountId))
    .for("update");
  if (acc?.mainCharacterId === characterId) {
    await applyNoMainRule(dbx, existing.accountId, "main unlinked");
  } else {
    await enqueueSync(dbx, { kind: "account", accountId: existing.accountId });
  }
  if (opts.revokeSessions) await revokeAccountSessions(dbx, existing.accountId);
}

export async function setMainCharacter(
  dbx: DbTx,
  accountId: string,
  characterId: number,
): Promise<void> {
  const rows = await dbx
    .select()
    .from(character)
    .where(and(eq(character.id, characterId), eq(character.accountId, accountId)))
    .for("update");
  if (rows.length === 0) throw new Error("character not on account");
  await dbx
    .select()
    .from(account)
    .where(eq(account.id, accountId))
    .for("update");
  await dbx
    .update(account)
    .set({ mainCharacterId: characterId })
    .where(eq(account.id, accountId));
  await logAudit(dbx, {
    actor: accountId,
    action: "account.main_changed",
    target: accountId,
    details: { mainCharacterId: characterId },
  });
  await enqueueSync(dbx, { kind: "account", accountId });
}

export async function maybeGrantBootstrapAdmin(
  dbx: DbTx,
  cfg: Config,
  accountId: string,
  ch: { characterId: number; ownerHash: string },
): Promise<boolean> {
  if (!cfg.bootstrapAdminCharacterIds.includes(ch.characterId)) return false;
  const inserted = await dbx
    .insert(bootstrapAdminGrant)
    .values({ characterId: ch.characterId, ownerHash: ch.ownerHash, accountId })
    .onConflictDoNothing()
    .returning();
  if (inserted.length === 0) return false; // grant already consumed, ever
  await dbx.update(account).set({ isAdmin: true }).where(eq(account.id, accountId));
  await logAudit(dbx, {
    actor: "system",
    action: "admin.bootstrap_granted",
    target: accountId,
    details: { characterId: ch.characterId },
  });
  return true;
}

export async function demoteAdmin(
  dbx: DbTx,
  actor: string,
  accountId: string,
): Promise<{ ok: boolean; error?: "last_admin" }> {
  // Lock ALL admin rows first: two admins demoting each other serialize here,
  // and the second transaction re-counts after the first commits.
  const admins = await dbx
    .select()
    .from(account)
    .where(eq(account.isAdmin, true))
    .for("update");
  const otherAdmins = admins.filter((a) => a.id !== accountId);
  if (otherAdmins.length === 0) return { ok: false, error: "last_admin" };
  await dbx.update(account).set({ isAdmin: false }).where(eq(account.id, accountId));
  await logAudit(dbx, { actor, action: "admin.demoted", target: accountId });
  return { ok: true };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- tests/accounts.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full suite and commit**

Run: `npm test && npm run typecheck`

```bash
git add src/services/accounts.ts tests/accounts.test.ts
git commit -m "feat: account service with reclaim, no-main rule, bootstrap admin"
```

---

### Task 9: EVE auth routes and login page

**Files:**
- Create: `src/app/auth/eve/login/route.ts`, `src/app/auth/eve/link/route.ts`, `src/app/auth/eve/callback/route.ts`, `src/app/login/page.tsx`, `src/lib/request-session.ts`
- Test: `tests/auth-routes.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 4–8.
- Produces:
  - `GET /auth/eve/login` — creates `oauth_transaction` (intent `login`), 302 to EVE authorize URL.
  - `GET /auth/eve/link` — requires session; transaction bound to session + account (intent `link-character`); 302 to authorize URL.
  - `GET /auth/eve/callback?code&state` — consumes transaction; verifies intent binding (a `link-character` transaction is honored only when its `sessionId` still resolves to its `accountId`); exchanges code with PKCE verifier; verifies JWT; requires the exact expected intent (`login` or `link-character`; anything else → 400); inside one `db.transaction()` calls `handleEveLogin` or `linkCharacter` (bootstrap admin is internal to those); on login sets the session cookie; redirects to `/account` (or `/account?error=already_linked`).
  - `src/lib/request-session.ts`: `getRequestAccount(req: NextRequest): Promise<{ accountId: string; sessionId: string } | null>` reading the session cookie.
- Note: route handlers are exported as `GET` functions taking `NextRequest`; tests call them directly (no server) with `NextRequest` objects and mocked `fetch` (msw node server) for the token endpoint, plus a locally-signed JWT and injected JWKS via a test seam: `verifyEveAccessToken` accepts `getKey` — the callback route reads an optional `globalThis.__eveJwksForTest` (typed in `src/lib/esi/sso.ts` as exported `let testJwksOverride: JWTVerifyGetKey | undefined` with setter `setTestJwksOverride()`), used only in tests.

- [ ] **Step 1: Write failing test**

`tests/auth-routes.test.ts`:

```ts
import { NextRequest } from "next/server";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, character } from "@/db/schema";
import { setTestJwksOverride } from "@/lib/esi/sso";
import { setupTestDb } from "./helpers/db";

// Route modules read config + db lazily via getConfig()/getDb(); set env first.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://authgd:authgd@localhost:5433/authgd_test";
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.APP_BASE_URL = "http://localhost:3000";
process.env.ALLIANCE_ID = "99000001";
process.env.EVE_SSO_CLIENT_ID = "cid";
process.env.EVE_SSO_CLIENT_SECRET = "sec";
process.env.EVE_SSO_SCOPES = "esi-characters.read_contacts.v1";
process.env.DISCORD_CLIENT_ID = "d";
process.env.DISCORD_CLIENT_SECRET = "d";
process.env.DISCORD_BOT_TOKEN = "d";
process.env.DISCORD_GUILD_ID = "1";
process.env.DISCORD_ROLE_ID_FLYGD = "10";
process.env.DISCORD_ROLE_ID_BLUE = "11";
process.env.DISCORD_ROLE_ID_GREEN = "12";
process.env.WANDERER_BASE_URL = "https://w.example";
process.env.WANDERER_API_KEY = "k";
process.env.WANDERER_MAP_SLUG = "m";
process.env.WANDERER_ACL_ID = "a";

const { GET: loginRoute } = await import("@/app/auth/eve/login/route");
const { GET: callbackRoute } = await import("@/app/auth/eve/callback/route");

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
let signToken: (characterId: number, owner: string) => Promise<string>;

const msw = setupServer(
  http.post("https://login.eveonline.com/v2/oauth/token", () =>
    HttpResponse.json({ access_token: "SET_PER_TEST", refresh_token: "rt" }),
  ),
);

beforeAll(async () => {
  ctx = await setupTestDb();
  msw.listen({ onUnhandledRequest: "error" });
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  setTestJwksOverride(
    createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: "RS256" }] }),
  );
  signToken = (characterId, owner) =>
    new SignJWT({ name: `Char ${characterId}`, owner, scp: ["esi-characters.read_contacts.v1"] })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("https://login.eveonline.com")
      .setAudience("EVE Online")
      .setSubject(`CHARACTER:EVE:${characterId}`)
      .setExpirationTime("5m")
      .sign(privateKey);
});
afterAll(async () => {
  msw.close();
  await ctx.cleanup();
});

describe("EVE auth flow", () => {
  it("login → redirect → callback creates account and sets session cookie", async () => {
    const loginRes = await loginRoute(new NextRequest("http://localhost:3000/auth/eve/login"));
    expect(loginRes.status).toBe(307);
    const authorize = new URL(loginRes.headers.get("location")!);
    const state = authorize.searchParams.get("state")!;

    const jwt = await signToken(90000001, "oh-1");
    msw.use(
      http.post("https://login.eveonline.com/v2/oauth/token", () =>
        HttpResponse.json({ access_token: jwt, refresh_token: "rt" }),
      ),
    );

    const cbRes = await callbackRoute(
      new NextRequest(
        `http://localhost:3000/auth/eve/callback?code=abc&state=${encodeURIComponent(state)}`,
      ),
    );
    expect(cbRes.status).toBe(307);
    expect(new URL(cbRes.headers.get("location")!).pathname).toBe("/account");
    expect(cbRes.headers.get("set-cookie")).toContain("authgd_session=");

    const accounts = await ctx.db.select().from(account);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].tier).toBe("green");
    const chars = await ctx.db.select().from(character);
    expect(chars[0].id).toBe(90000001);
  });

  it("rejects an unknown or replayed state", async () => {
    const res = await callbackRoute(
      new NextRequest("http://localhost:3000/auth/eve/callback?code=abc&state=bogus"),
    );
    expect(res.status).toBe(400);

    // full replay: consume once successfully, then reuse the same state
    const loginRes = await loginRoute(new NextRequest("http://localhost:3000/auth/eve/login"));
    const state = new URL(loginRes.headers.get("location")!).searchParams.get("state")!;
    const jwt = await signToken(90000011, "oh-11");
    msw.use(
      http.post("https://login.eveonline.com/v2/oauth/token", () =>
        HttpResponse.json({ access_token: jwt, refresh_token: "rt" }),
      ),
    );
    const url = `http://localhost:3000/auth/eve/callback?code=abc&state=${encodeURIComponent(state)}`;
    expect((await callbackRoute(new NextRequest(url))).status).toBe(307);
    expect((await callbackRoute(new NextRequest(url))).status).toBe(400);
  });

  it("rejects an expired state", async () => {
    const loginRes = await loginRoute(new NextRequest("http://localhost:3000/auth/eve/login"));
    const state = new URL(loginRes.headers.get("location")!).searchParams.get("state")!;
    const { oauthTransaction } = await import("@/db/schema");
    await ctx.db
      .update(oauthTransaction)
      .set({ expiresAt: new Date(Date.now() - 1000) });
    const res = await callbackRoute(
      new NextRequest(
        `http://localhost:3000/auth/eve/callback?code=abc&state=${encodeURIComponent(state)}`,
      ),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a link-character transaction without its initiating session", async () => {
    // craft a link transaction directly, then hit the callback with no cookie
    const { createOauthTransaction } = await import("@/services/oauth-tx");
    const [acc] = await ctx.db.insert(account).values({}).returning();
    const tx = await createOauthTransaction(ctx.db, {
      intent: "link-character",
      sessionId: "some-session",
      accountId: acc.id,
    });
    const jwt = await signToken(90000012, "oh-12");
    msw.use(
      http.post("https://login.eveonline.com/v2/oauth/token", () =>
        HttpResponse.json({ access_token: jwt, refresh_token: "rt" }),
      ),
    );
    const res = await callbackRoute(
      new NextRequest(
        `http://localhost:3000/auth/eve/callback?code=abc&state=${encodeURIComponent(tx.state)}`,
      ),
    );
    expect(res.status).toBe(403);
  });

  it("rejects a link-discord transaction presented to the EVE callback without consuming it", async () => {
    const { createOauthTransaction, consumeOauthTransaction } = await import(
      "@/services/oauth-tx"
    );
    const tx = await createOauthTransaction(ctx.db, { intent: "link-discord" });
    // no token-endpoint mock needed: rejection happens before any EVE call
    const res = await callbackRoute(
      new NextRequest(
        `http://localhost:3000/auth/eve/callback?code=abc&state=${encodeURIComponent(tx.state)}`,
      ),
    );
    expect(res.status).toBe(400);
    // the transaction survives for its rightful callback
    expect(
      await consumeOauthTransaction(ctx.db, tx.state, ["link-discord"]),
    ).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test -- tests/auth-routes.test.ts`
Expected: FAIL (routes missing; `setTestJwksOverride` missing).

- [ ] **Step 3: Implement**

Add to `src/lib/esi/sso.ts` (test seam):

```ts
export let testJwksOverride: JWTVerifyGetKey | undefined;
export function setTestJwksOverride(getKey: JWTVerifyGetKey | undefined) {
  testJwksOverride = getKey;
}
```

and change `verifyEveAccessToken` to use `getKey ?? testJwksOverride ?? remoteJwks`.

`src/lib/request-session.ts`:

```ts
import type { NextRequest } from "next/server";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { getSessionAccount } from "@/services/session";

export async function getRequestAccount(
  req: NextRequest,
): Promise<{ accountId: string; sessionId: string } | null> {
  const cfg = getConfig();
  const sid = req.cookies.get(cfg.sessionCookieName)?.value;
  if (!sid) return null;
  const resolved = await getSessionAccount(getDb(), sid);
  if (!resolved) return null;
  return { accountId: resolved.accountId, sessionId: sid };
}
```

`src/app/auth/eve/login/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { buildEveAuthorizeUrl } from "@/lib/esi/sso";
import { createOauthTransaction } from "@/services/oauth-tx";

export async function GET(_req: NextRequest) {
  const cfg = getConfig();
  const tx = await createOauthTransaction(getDb(), { intent: "login" });
  return NextResponse.redirect(buildEveAuthorizeUrl(cfg, tx.state, tx.codeChallenge));
}
```

`src/app/auth/eve/link/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { buildEveAuthorizeUrl } from "@/lib/esi/sso";
import { getRequestAccount } from "@/lib/request-session";
import { createOauthTransaction } from "@/services/oauth-tx";

export async function GET(req: NextRequest) {
  const cfg = getConfig();
  const sess = await getRequestAccount(req);
  if (!sess) return NextResponse.redirect(new URL("/login", cfg.appBaseUrl));
  const tx = await createOauthTransaction(getDb(), {
    intent: "link-character",
    sessionId: sess.sessionId,
    accountId: sess.accountId,
  });
  return NextResponse.redirect(buildEveAuthorizeUrl(cfg, tx.state, tx.codeChallenge));
}
```

`src/app/auth/eve/callback/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { exchangeEveCode, verifyEveAccessToken } from "@/lib/esi/sso";
import { getRequestAccount } from "@/lib/request-session";
import {
  handleEveLogin,
  linkCharacter,
  type EveCallbackCharacter,
} from "@/services/accounts";
import { consumeOauthTransaction } from "@/services/oauth-tx";
import { createSession } from "@/services/session";

export async function GET(req: NextRequest) {
  const cfg = getConfig();
  const db = getDb();
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  if (!code || !state) return new NextResponse("missing params", { status: 400 });

  // Only EVE intents are consumable here; a link-discord transaction is
  // rejected WITHOUT being consumed. All binding checks run before any EVE call.
  const tx = await consumeOauthTransaction(db, state, ["login", "link-character"]);
  if (!tx) return new NextResponse("invalid or expired state", { status: 400 });

  const sess = await getRequestAccount(req);
  if (
    tx.intent === "link-character" &&
    (!sess || sess.sessionId !== tx.sessionId || sess.accountId !== tx.accountId)
  ) {
    return new NextResponse("link transaction not valid for this session", {
      status: 403,
    });
  }

  const tokens = await exchangeEveCode(cfg, code, tx.pkceVerifier);
  const identity = await verifyEveAccessToken(tokens.accessToken);
  const ch: EveCallbackCharacter = {
    characterId: identity.characterId,
    characterName: identity.characterName,
    ownerHash: identity.ownerHash,
    scopes: identity.scopes,
    refreshToken: tokens.refreshToken,
  };

  if (tx.intent === "link-character") {
    const result = await db.transaction((dbtx) =>
      linkCharacter(dbtx, cfg, sess!.accountId, ch),
    );
    const dest = result.ok ? "/account" : "/account?error=already_linked";
    return NextResponse.redirect(new URL(dest, cfg.appBaseUrl));
  }

  const { accountId } = await db.transaction((dbtx) =>
    handleEveLogin(dbtx, cfg, ch),
  );
  const sid = await createSession(db, accountId);
  const res = NextResponse.redirect(new URL("/account", cfg.appBaseUrl));
  res.cookies.set(cfg.sessionCookieName, sid, {
    httpOnly: true,
    sameSite: "lax",
    secure: cfg.appBaseUrl.startsWith("https"),
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
  return res;
}
```

`src/app/login/page.tsx`:

```tsx
export default function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  return (
    <main style={{ maxWidth: 480, margin: "10vh auto", textAlign: "center" }}>
      <h1>authGD</h1>
      <p>Corporation auth for FlyGD.</p>
      <a href="/auth/eve/login">
        <img
          src="https://web.ccpgamescdn.com/eveonlineassets/developers/eve-sso-login-black-large.png"
          alt="Log in with EVE Online"
        />
      </a>
    </main>
  );
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npm test -- tests/auth-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite, typecheck, commit**

Run: `npm test && npm run typecheck`

```bash
git add src/app/auth src/app/login src/lib/request-session.ts src/lib/esi/sso.ts tests/auth-routes.test.ts
git commit -m "feat: EVE SSO login/link/callback routes and login page"
```

---

### Task 10: Discord OAuth linking

**Files:**
- Create: `src/lib/discord/oauth.ts`, `src/app/auth/discord/link/route.ts`, `src/app/auth/discord/callback/route.ts`, `src/services/discord-link.ts`
- Test: `tests/discord-link.test.ts`

**Interfaces:**
- Consumes: oauth-tx service, session, config.
- Produces:
  - `buildDiscordAuthorizeUrl(cfg: Config, state: string, codeChallenge: string): string` — `https://discord.com/oauth2/authorize` with `client_id`, `response_type=code`, `redirect_uri=${appBaseUrl}/auth/discord/callback`, `scope=identify`, `state`, `code_challenge`, `code_challenge_method=S256`. PKCE is used on Discord exactly as on EVE (confidential clients may still use PKCE; the global constraint applies to every flow).
  - `exchangeDiscordCode(cfg, code, codeVerifier, fetchImpl?): Promise<{ accessToken: string }>` — POST `https://discord.com/api/oauth2/token` including `code_verifier`.
  - `fetchDiscordUser(accessToken: string, fetchImpl?): Promise<{ id: string; username: string }>` — GET `https://discord.com/api/users/@me`.
  - `linkDiscord(dbx: DbTx, accountId: string, discordUserId: string): Promise<{ ok: true } | { ok: false; error: "already_linked" }>` — linked to another account → `already_linked`. The upsert on the account's own row runs **before** any side effects; a concurrent-race unique violation (`23505`) throws typed `DiscordLinkConflictError` **through the transaction** so the old-link deletion and deprovision event roll back — the route catches it outside `db.transaction()` and maps it to `already_linked`. A successful replacement audits `discord.unlinked` + enqueues `{ kind: "discord-user", discordUserId: <old id> }` (Plan 2 strips the old user's managed roles), then audits `discord.linked` + enqueues the `account` row.
  - Routes `GET /auth/discord/link` (requires session; intent `link-discord`; PKCE) and `GET /auth/discord/callback` (consume tx — exact intent required, session must match, exchange with verifier, fetch user, call `linkDiscord`, redirect to `/account` or `/account?error=discord_already_linked`).

- [ ] **Step 1: Write failing test**

`tests/discord-link.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { account, discordLink, outbox } from "@/db/schema";
import { linkDiscord } from "@/services/discord-link";
import { setupTestDb } from "./helpers/db";

// linkDiscord requires a DbTx; wrap every call in a transaction.

// Route tests below load config lazily via getConfig(): set the same
// process.env block used at the top of tests/auth-routes.test.ts BEFORE the
// imports above (copy it verbatim, including DATABASE_URL pointing at
// TEST_DATABASE_URL).

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
beforeEach(() =>
  ctx.db.execute(sql`TRUNCATE account, discord_link, outbox RESTART IDENTITY CASCADE`),
);
afterAll(() => ctx.cleanup());

// helper: run linkDiscord in a transaction (DbTx required)
const ld = (accountId: string, discordUserId: string) =>
  ctx.db.transaction((tx) => linkDiscord(tx, accountId, discordUserId));

describe("linkDiscord", () => {
  it("links and writes outbox", async () => {
    const [a] = await ctx.db.insert(account).values({}).returning();
    expect(await ld(a.id, "duid-1")).toEqual({ ok: true });
    expect(await ctx.db.select().from(outbox)).toHaveLength(1);
  });

  it("rejects a discord user linked to another account", async () => {
    const [a] = await ctx.db.insert(account).values({}).returning();
    const [b] = await ctx.db.insert(account).values({}).returning();
    await ld(a.id, "duid-1");
    expect(await ld(b.id, "duid-1")).toEqual({
      ok: false,
      error: "already_linked",
    });
  });

  it("replacing its own link deprovisions the old discord user", async () => {
    const [a] = await ctx.db.insert(account).values({}).returning();
    await ld(a.id, "duid-1");
    await ctx.db.delete(outbox);
    expect(await ld(a.id, "duid-2")).toEqual({ ok: true });
    const rows = await ctx.db.select().from(discordLink);
    expect(rows).toHaveLength(1);
    expect(rows[0].discordUserId).toBe("duid-2");
    const payloads = (await ctx.db.select().from(outbox)).map((b) => b.payload);
    expect(payloads).toContainEqual({ kind: "discord-user", discordUserId: "duid-1" });
    expect(payloads).toContainEqual({ kind: "account", accountId: a.id });
  });

  it("concurrent replacements deprovision every intermediate discord user", async () => {
    const [a] = await ctx.db.insert(account).values({}).returning();
    await ld(a.id, "duid-0");
    await ctx.db.delete(outbox);
    await Promise.all([ld(a.id, "duid-A"), ld(a.id, "duid-B")]);
    const deprovisioned = (await ctx.db.select().from(outbox))
      .map((b) => b.payload)
      .filter((p) => p.kind === "discord-user")
      .map((p) => (p as { discordUserId: string }).discordUserId);
    const [final] = await ctx.db.select().from(discordLink);
    // duid-0 and whichever of A/B lost the race must both be deprovisioned
    const loser = final.discordUserId === "duid-A" ? "duid-B" : "duid-A";
    expect(deprovisioned).toContain("duid-0");
    expect(deprovisioned).toContain(loser);
  });

  it("concurrent cross-account claims of one discord user: one wins, one conflicts", async () => {
    const { DiscordLinkConflictError } = await import("@/services/discord-link");
    const [a] = await ctx.db.insert(account).values({}).returning();
    const [b] = await ctx.db.insert(account).values({}).returning();
    const results = await Promise.allSettled([ld(a.id, "duid-X"), ld(b.id, "duid-X")]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    // either the slow one saw the committed row (already_linked) or hit 23505
    if (rejected.length === 1) {
      expect(
        (rejected[0] as PromiseRejectedResult).reason,
      ).toBeInstanceOf(DiscordLinkConflictError);
      expect(fulfilled).toHaveLength(1);
    } else {
      const values = fulfilled.map((r) => (r as PromiseFulfilledResult<unknown>).value);
      expect(values).toContainEqual({ ok: false, error: "already_linked" });
    }
    expect(await ctx.db.select().from(discordLink)).toHaveLength(1);
  });
});

describe("discord callback route", () => {
  // Route-level coverage: state binding, session binding, and success path.
  it("links via the callback when session matches the transaction", async () => {
    const { GET: discordCallback } = await import("@/app/auth/discord/callback/route");
    const { createOauthTransaction } = await import("@/services/oauth-tx");
    const { createSession } = await import("@/services/session");
    const { NextRequest } = await import("next/server");
    const { http, HttpResponse } = await import("msw");
    const { setupServer } = await import("msw/node");

    const msw = setupServer(
      http.post("https://discord.com/api/oauth2/token", async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        expect(body.get("code_verifier")).toBeTruthy();
        return HttpResponse.json({ access_token: "dt" });
      }),
      http.get("https://discord.com/api/users/@me", () =>
        HttpResponse.json({ id: "duid-route", username: "user" }),
      ),
    );
    msw.listen({ onUnhandledRequest: "error" });
    try {
      const [acc] = await ctx.db.insert(account).values({}).returning();
      const sid = await createSession(ctx.db, acc.id);
      const tx = await createOauthTransaction(ctx.db, {
        intent: "link-discord",
        sessionId: sid,
        accountId: acc.id,
      });
      const req = new NextRequest(
        `http://localhost:3000/auth/discord/callback?code=c&state=${encodeURIComponent(tx.state)}`,
        { headers: { cookie: `authgd_session=${sid}` } },
      );
      const res = await discordCallback(req);
      expect(res.status).toBe(307);
      const rows = await ctx.db.select().from(discordLink);
      expect(rows[0]?.discordUserId).toBe("duid-route");
    } finally {
      msw.close();
    }
  });

  it("rejects the callback without the initiating session", async () => {
    const { GET: discordCallback } = await import("@/app/auth/discord/callback/route");
    const { createOauthTransaction } = await import("@/services/oauth-tx");
    const { NextRequest } = await import("next/server");
    const [acc] = await ctx.db.insert(account).values({}).returning();
    const tx = await createOauthTransaction(ctx.db, {
      intent: "link-discord",
      sessionId: "sid-x",
      accountId: acc.id,
    });
    const res = await discordCallback(
      new NextRequest(
        `http://localhost:3000/auth/discord/callback?code=c&state=${encodeURIComponent(tx.state)}`,
      ),
    );
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test -- tests/discord-link.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/services/discord-link.ts`:

```ts
import { eq } from "drizzle-orm";
import type { DbTx } from "@/db";
import { account, discordLink } from "@/db/schema";
import { logAudit } from "@/services/audit";
import { enqueueSync } from "@/services/outbox";

/** Drizzle may wrap the pg error; walk the cause chain for code 23505. */
function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 5; depth++) {
    if (typeof cur === "object" && (cur as { code?: string }).code === "23505") {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Thrown THROUGH the transaction so a concurrent uniqueness race rolls back
 * everything (including any old-link deletion + deprovision event). Callers
 * catch it OUTSIDE db.transaction() and map it to `already_linked`.
 */
export class DiscordLinkConflictError extends Error {
  constructor() {
    super("discord user already linked to another account");
  }
}

export async function linkDiscord(
  dbx: DbTx,
  accountId: string,
  discordUserId: string,
): Promise<{ ok: true } | { ok: false; error: "already_linked" }> {
  // Lock the account row first: concurrent replacements for one account
  // serialize here, so every intermediate discord user gets its deprovision
  // event (the second replacement reads the first one's committed row).
  await dbx
    .select()
    .from(account)
    .where(eq(account.id, accountId))
    .for("update");
  const existing = await dbx
    .select()
    .from(discordLink)
    .where(eq(discordLink.discordUserId, discordUserId));
  if (existing.length > 0 && existing[0].accountId !== accountId) {
    return { ok: false, error: "already_linked" };
  }
  // Upsert on our own account row; the unique(discord_user_id) index is the
  // cross-account race arbiter. Only after it succeeds do we emit side effects.
  const previous = await dbx
    .select()
    .from(discordLink)
    .where(eq(discordLink.accountId, accountId));
  const previousUserId =
    previous.length > 0 && previous[0].discordUserId !== discordUserId
      ? previous[0].discordUserId
      : null;
  try {
    await dbx
      .insert(discordLink)
      .values({ accountId, discordUserId })
      .onConflictDoUpdate({
        target: discordLink.accountId,
        set: { discordUserId, linkedAt: new Date() },
      });
  } catch (err) {
    // concurrent claim of the same discord user: abort the whole transaction
    if (isUniqueViolation(err)) throw new DiscordLinkConflictError();
    throw err;
  }
  if (previousUserId) {
    await logAudit(dbx, {
      actor: accountId,
      action: "discord.unlinked",
      target: previousUserId,
      details: { reason: "replaced" },
    });
    await enqueueSync(dbx, { kind: "discord-user", discordUserId: previousUserId });
  }
  await logAudit(dbx, {
    actor: accountId,
    action: "discord.linked",
    target: discordUserId,
  });
  await enqueueSync(dbx, { kind: "account", accountId });
  return { ok: true };
}
```

`src/lib/discord/oauth.ts`:

```ts
import type { Config } from "@/config";

export function buildDiscordAuthorizeUrl(
  cfg: Config,
  state: string,
  codeChallenge: string,
): string {
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", cfg.discord.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", `${cfg.appBaseUrl}/auth/discord/callback`);
  url.searchParams.set("scope", "identify");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeDiscordCode(
  cfg: Config,
  code: string,
  codeVerifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ accessToken: string }> {
  const res = await fetchImpl("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.discord.clientId,
      client_secret: cfg.discord.clientSecret,
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      redirect_uri: `${cfg.appBaseUrl}/auth/discord/callback`,
    }).toString(),
  });
  if (!res.ok) throw new Error(`discord token exchange failed (${res.status})`);
  const json = (await res.json()) as { access_token: string };
  return { accessToken: json.access_token };
}

export async function fetchDiscordUser(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; username: string }> {
  const res = await fetchImpl("https://discord.com/api/users/@me", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`discord user fetch failed (${res.status})`);
  const json = (await res.json()) as { id: string; username: string };
  return { id: json.id, username: json.username };
}
```

`src/app/auth/discord/link/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { buildDiscordAuthorizeUrl } from "@/lib/discord/oauth";
import { getRequestAccount } from "@/lib/request-session";
import { createOauthTransaction } from "@/services/oauth-tx";

export async function GET(req: NextRequest) {
  const cfg = getConfig();
  const sess = await getRequestAccount(req);
  if (!sess) return NextResponse.redirect(new URL("/login", cfg.appBaseUrl));
  const tx = await createOauthTransaction(getDb(), {
    intent: "link-discord",
    sessionId: sess.sessionId,
    accountId: sess.accountId,
  });
  return NextResponse.redirect(
    buildDiscordAuthorizeUrl(cfg, tx.state, tx.codeChallenge),
  );
}
```

`src/app/auth/discord/callback/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { exchangeDiscordCode, fetchDiscordUser } from "@/lib/discord/oauth";
import { getRequestAccount } from "@/lib/request-session";
import { DiscordLinkConflictError, linkDiscord } from "@/services/discord-link";
import { consumeOauthTransaction } from "@/services/oauth-tx";

export async function GET(req: NextRequest) {
  const cfg = getConfig();
  const db = getDb();
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  if (!code || !state) return new NextResponse("missing params", { status: 400 });

  const tx = await consumeOauthTransaction(db, state, ["link-discord"]);
  if (!tx) {
    return new NextResponse("invalid or expired state", { status: 400 });
  }
  const sess = await getRequestAccount(req);
  if (!sess || sess.sessionId !== tx.sessionId || sess.accountId !== tx.accountId) {
    return new NextResponse("link transaction not valid for this session", {
      status: 403,
    });
  }
  const { accessToken } = await exchangeDiscordCode(cfg, code, tx.pkceVerifier);
  const user = await fetchDiscordUser(accessToken);
  let ok: boolean;
  try {
    const result = await db.transaction((dbtx) =>
      linkDiscord(dbtx, sess.accountId, user.id),
    );
    ok = result.ok;
  } catch (err) {
    if (err instanceof DiscordLinkConflictError) ok = false;
    else throw err;
  }
  const dest = ok ? "/account" : "/account?error=discord_already_linked";
  return NextResponse.redirect(new URL(dest, cfg.appBaseUrl));
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npm test -- tests/discord-link.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/discord src/app/auth/discord src/services/discord-link.ts tests/discord-link.test.ts
git commit -m "feat: discord OAuth linking with unique-user enforcement"
```

---

### Task 11: Member account page

**Files:**
- Create: `src/app/account/page.tsx`, `src/app/account/actions.ts`, `src/services/account-view.ts`
- Test: `tests/account-view.test.ts`

**Interfaces:**
- Consumes: session, schema, `setMainCharacter`, `unlinkCharacter`.
- Produces: `getAccountView(dbx, cfg: Config, accountId: string): Promise<AccountView>` where

```ts
interface AccountView {
  tier: "flygd" | "blue" | "green";
  status: "active" | "cryo";
  isAdmin: boolean;
  mainCharacterId: number | null;
  discordLinked: boolean;
  characters: Array<{
    id: number;
    name: string;
    isMain: boolean;
    tokenStatus: "valid" | "invalid" | "needs_reauth" | "missing";
    needsReauthForScopes: boolean; // granted scopes ⊉ cfg.eveSso.scopes
    contactSyncResult: string | null; // from contact_sync_state.last_result (e.g. "missing_label")
    onMapAcl: boolean; // from wanderer_acl_observation
  }>;
}
```

- Server actions in `actions.ts`: `setMainAction(characterId: number)`, `unlinkAction(characterId: number)` — resolve session via `cookies()`, run in `db.transaction()`, `revalidatePath("/account")`.
- Page renders: tier badge, character rows (portrait `https://images.evetech.net/characters/<id>/portrait?size=64`, name, main marker, token state incl. "re-auth needed" link to `/auth/eve/link`, contact sync remediation text when `missing_label` — copy: “Create a contact label named `flygd` in-game, then re-sync.”, map ✓/✗), "Add character" → `/auth/eve/link`, "Link Discord" → `/auth/discord/link`, error banners for `?error=already_linked` / `?error=discord_already_linked`, and the label-ownership notice: “authGD owns the `flygd` contact label on your characters: contacts under that label are managed automatically and may be added, changed, or removed.”

- [ ] **Step 1: Write failing test**

`tests/account-view.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { loadConfig, type Config } from "@/config";
import {
  account,
  character,
  contactSyncState,
  discordLink,
  wandererAclObservation,
} from "@/db/schema";
import { getAccountView } from "@/services/account-view";
import { setupTestDb } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
let cfg: Config;

beforeAll(async () => {
  ctx = await setupTestDb();
  cfg = loadConfig({
    ...process.env,
    DATABASE_URL: "postgres://x/y",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    APP_BASE_URL: "http://localhost:3000",
    ALLIANCE_ID: "99000001",
    EVE_SSO_CLIENT_ID: "c",
    EVE_SSO_CLIENT_SECRET: "s",
    EVE_SSO_SCOPES: "esi-characters.read_contacts.v1 esi-characters.write_contacts.v1",
    DISCORD_CLIENT_ID: "d",
    DISCORD_CLIENT_SECRET: "d",
    DISCORD_BOT_TOKEN: "d",
    DISCORD_GUILD_ID: "1",
    DISCORD_ROLE_ID_FLYGD: "10",
    DISCORD_ROLE_ID_BLUE: "11",
    DISCORD_ROLE_ID_GREEN: "12",
    WANDERER_BASE_URL: "https://w.example",
    WANDERER_API_KEY: "k",
    WANDERER_MAP_SLUG: "m",
    WANDERER_ACL_ID: "a",
  } as NodeJS.ProcessEnv);
});
beforeEach(() =>
  ctx.db.execute(sql`
    TRUNCATE account, "character", discord_link, contact_sync_state,
      wanderer_acl_observation RESTART IDENTITY CASCADE
  `),
);
afterAll(() => ctx.cleanup());

describe("getAccountView", () => {
  it("assembles characters with token, sync, and map state", async () => {
    const [acc] = await ctx.db
      .insert(account)
      .values({ tier: "flygd", mainCharacterId: 1001 })
      .returning();
    await ctx.db.insert(character).values([
      {
        id: 1001,
        accountId: acc.id,
        name: "Main",
        ownerHash: "o1",
        scopes: [
          "esi-characters.read_contacts.v1",
          "esi-characters.write_contacts.v1",
        ],
        tokenStatus: "valid",
      },
      {
        id: 1002,
        accountId: acc.id,
        name: "Alt",
        ownerHash: "o1",
        scopes: ["esi-characters.read_contacts.v1"], // missing write scope
        tokenStatus: "valid",
      },
    ]);
    await ctx.db.insert(discordLink).values({ accountId: acc.id, discordUserId: "d1" });
    await ctx.db.insert(contactSyncState).values({
      characterId: 1002,
      lastResult: "missing_label",
    });
    await ctx.db.insert(wandererAclObservation).values({
      characterId: 1001,
      role: "member",
      observedAt: new Date(),
    });

    const view = await getAccountView(ctx.db, cfg, acc.id);
    expect(view.tier).toBe("flygd");
    expect(view.discordLinked).toBe(true);

    const main = view.characters.find((c) => c.id === 1001)!;
    expect(main.isMain).toBe(true);
    expect(main.needsReauthForScopes).toBe(false);
    expect(main.onMapAcl).toBe(true);

    const alt = view.characters.find((c) => c.id === 1002)!;
    expect(alt.needsReauthForScopes).toBe(true);
    expect(alt.contactSyncResult).toBe("missing_label");
    expect(alt.onMapAcl).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test -- tests/account-view.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/services/account-view.ts`:

```ts
import { eq, inArray } from "drizzle-orm";
import type { Config } from "@/config";
import type { Dbx } from "@/db";
import {
  account,
  character,
  contactSyncState,
  discordLink,
  wandererAclObservation,
} from "@/db/schema";

export interface AccountView {
  tier: "flygd" | "blue" | "green";
  status: "active" | "cryo";
  isAdmin: boolean;
  mainCharacterId: number | null;
  discordLinked: boolean;
  characters: Array<{
    id: number;
    name: string;
    isMain: boolean;
    tokenStatus: "valid" | "invalid" | "needs_reauth" | "missing";
    needsReauthForScopes: boolean;
    contactSyncResult: string | null;
    onMapAcl: boolean;
  }>;
}

export async function getAccountView(
  dbx: Dbx,
  cfg: Config,
  accountId: string,
): Promise<AccountView> {
  const [acc] = await dbx.select().from(account).where(eq(account.id, accountId));
  if (!acc) throw new Error("account not found");
  const chars = await dbx
    .select()
    .from(character)
    .where(eq(character.accountId, accountId));
  const ids = chars.map((c) => c.id);
  const [links, syncStates, aclObs] = await Promise.all([
    dbx.select().from(discordLink).where(eq(discordLink.accountId, accountId)),
    ids.length
      ? dbx.select().from(contactSyncState).where(inArray(contactSyncState.characterId, ids))
      : Promise.resolve([]),
    ids.length
      ? dbx
          .select()
          .from(wandererAclObservation)
          .where(inArray(wandererAclObservation.characterId, ids))
      : Promise.resolve([]),
  ]);
  const syncByChar = new Map(syncStates.map((s) => [s.characterId, s]));
  const aclSet = new Set(aclObs.map((o) => o.characterId));
  const required = new Set(cfg.eveSso.scopes);

  return {
    tier: acc.tier,
    status: acc.status,
    isAdmin: acc.isAdmin,
    mainCharacterId: acc.mainCharacterId,
    discordLinked: links.length > 0,
    characters: chars.map((c) => ({
      id: c.id,
      name: c.name,
      isMain: acc.mainCharacterId === c.id,
      tokenStatus: c.tokenStatus,
      needsReauthForScopes: [...required].some((s) => !c.scopes.includes(s)),
      contactSyncResult: syncByChar.get(c.id)?.lastResult ?? null,
      onMapAcl: aclSet.has(c.id),
    })),
  };
}
```

`src/app/account/actions.ts`:

```ts
"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { character } from "@/db/schema";
import { setMainCharacter, unlinkCharacter } from "@/services/accounts";
import { getSessionAccount } from "@/services/session";

async function requireAccount(): Promise<string> {
  const cfg = getConfig();
  const sid = (await cookies()).get(cfg.sessionCookieName)?.value;
  if (!sid) throw new Error("not signed in");
  const sess = await getSessionAccount(getDb(), sid);
  if (!sess) throw new Error("not signed in");
  return sess.accountId;
}

export async function setMainAction(characterId: number): Promise<void> {
  const accountId = await requireAccount();
  await getDb().transaction((dbtx) => setMainCharacter(dbtx, accountId, characterId));
  revalidatePath("/account");
}

export async function unlinkAction(characterId: number): Promise<void> {
  const accountId = await requireAccount();
  const db = getDb();
  const cfg = getConfig();
  await db.transaction(async (dbtx) => {
    // members may only unlink their own characters
    const owned = await dbtx
      .select()
      .from(character)
      .where(and(eq(character.id, characterId), eq(character.accountId, accountId)));
    if (owned.length === 0) throw new Error("not your character");
    await unlinkCharacter(dbtx, cfg, accountId, characterId);
  });
  revalidatePath("/account");
}
```

`src/app/account/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { getAccountView } from "@/services/account-view";
import { getSessionAccount } from "@/services/session";
import { setMainAction, unlinkAction } from "./actions";

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const cfg = getConfig();
  const sid = (await cookies()).get(cfg.sessionCookieName)?.value;
  const sess = sid ? await getSessionAccount(getDb(), sid) : null;
  if (!sess) redirect("/login");
  const view = await getAccountView(getDb(), cfg, sess.accountId);
  const { error } = await searchParams;

  return (
    <main style={{ maxWidth: 720, margin: "2rem auto", padding: "0 1rem" }}>
      <h1>Your account</h1>
      {error === "already_linked" && (
        <p role="alert">That character is already linked to another account.</p>
      )}
      {error === "discord_already_linked" && (
        <p role="alert">That Discord account is already linked to another account.</p>
      )}
      <p>
        Tier: <strong>{view.tier}</strong>
        {view.status === "cryo" && " · cryo"}
      </p>
      <p>
        Discord: {view.discordLinked ? "linked" : <a href="/auth/discord/link">Link Discord</a>}
      </p>
      <h2>Characters</h2>
      <table>
        <thead>
          <tr>
            <th></th>
            <th>Name</th>
            <th>Token</th>
            <th>Contacts</th>
            <th>Map</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {view.characters.map((c) => (
            <tr key={c.id}>
              <td>
                <img
                  src={`https://images.evetech.net/characters/${c.id}/portrait?size=64`}
                  alt=""
                  width={32}
                  height={32}
                />
              </td>
              <td>
                {c.name} {c.isMain && <strong>(main)</strong>}
              </td>
              <td>
                {c.tokenStatus === "valid" && !c.needsReauthForScopes && "ok"}
                {(c.tokenStatus !== "valid" || c.needsReauthForScopes) && (
                  <a href="/auth/eve/link">re-auth needed</a>
                )}
              </td>
              <td>
                {c.contactSyncResult === "missing_label"
                  ? `Create a contact label named "${cfg.standings.label}" in-game, then re-sync.`
                  : (c.contactSyncResult ?? "—")}
              </td>
              <td>{c.onMapAcl ? "✓" : "✗"}</td>
              <td>
                {!c.isMain && (
                  <form action={setMainAction.bind(null, c.id)} style={{ display: "inline" }}>
                    <button type="submit">make main</button>
                  </form>
                )}
                <form action={unlinkAction.bind(null, c.id)} style={{ display: "inline" }}>
                  <button type="submit">unlink</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        <a href="/auth/eve/link">Add character</a>
      </p>
      <p style={{ fontSize: "0.85em", opacity: 0.8 }}>
        authGD owns the <code>{cfg.standings.label}</code> contact label on your
        characters: contacts under that label are managed automatically and may be
        added, changed, or removed.
      </p>
    </main>
  );
}
```

- [ ] **Step 4: Run tests, typecheck, build**

Run: `npm test -- tests/account-view.test.ts && npm run typecheck && npm run build`
Expected: all PASS / build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/app/account src/services/account-view.ts tests/account-view.test.ts
git commit -m "feat: member account page with character/token/map status"
```

---

### Task 12: Plan 1 wrap-up — full verification

**Files:**
- Modify: none expected; fix anything the checks surface.

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 2: Typecheck and production build**

Run: `npm run typecheck && npm run build`
Expected: clean.

- [ ] **Step 3: Manual smoke (optional but recommended)**

Run: `npm run db:migrate && npm run dev` with a real `.env` (EVE dev-app credentials) and click through login → account → add character.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "chore: plan 1 verification fixes"
```

---

## Not in this plan (Plans 2 and 3)

- **Plan 2 — Sync Engine:** worker entry (pg-boss start, schedules), outbox dispatcher consuming `takeUndispatched`/`markDispatched`, ESI client with error-limit throttling, affiliation refresh (chunk + bisect via `classifyEsiError`), membership verification job + tier transitions, contact push (labels, pagination, label-ownership reconciliation, `missing_label`, `needs_reauth` per-job scope gating), Wanderer ACL sync (+ post-mutation observation), Discord role sync (+ config validation, `discord-user` deprovision payloads), token health job (uses `refreshEveToken` + `classifyOAuthError`), `sync_run` recording, ops webhook.
- **Plan 3 — Admin UI & Ops:** admin accounts page (tier/lock controls, cryo + notes, sort/filter, map + last-login columns), audit log page, sync status page with "sync now", admin management (uses `demoteAdmin`), Dockerfile + deploy config, Playwright smoke tests.
