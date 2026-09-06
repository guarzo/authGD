/**
 * Manual, live-only feasibility probe for FLEET_READ_SCOPE (Task 2 of the
 * shared-fleet-telemetry tracer). Confirms — against real ESI, with a real
 * consenting character in an isolated environment — that the two fleet
 * endpoints answer with the status, Cache-Control, and ETag the design needs.
 *
 * Never prints who the character is, who is in the fleet, or what either
 * endpoint's body actually contained. `esi.getCharacterFleet` /
 * `esi.getFleetMembers` (src/lib/esi/client.ts) already narrow the parsed
 * value to the two-and-one fields a fleet-membership probe needs; this script
 * additionally never logs the value at all, only the transport-level
 * evidence (status, cache headers, and a bare member count).
 *
 * Usage (SYNC_MODE=live, against an isolated environment; the character must
 * already be linked in THIS environment's database, have granted
 * FLEET_READ_SCOPE via `?grant=fleet-read` on the link route, and be in a
 * fleet at the time this runs — or the probe reports the negative result the
 * design also needs, since a 403 or 404 is evidence, not a bug):
 *
 *   npx tsx --env-file-if-exists=.env scripts/fleet-esi-feasibility.ts <linked character id>
 *
 * Each of the two ESI calls is caught independently: a thrown `EsiError`
 * (non-2xx status, or a malformed body treated as unusable rather than an
 * empty fleet — see client.ts) is reported as its own redacted status line
 * with `cache-control=absent, etag=absent`, because the headers of a response
 * that never parsed successfully are not retained by the client. This script
 * deliberately does NOT invent a placeholder fleet id to force a second probe
 * when the first one fails — the roster read has no fleet id to call with in
 * that case, so only the one line is reported. The process exit code is
 * decided once at the very end, after every probe that could be attempted has
 * been reported, never inside a catch block.
 */
import { eq } from "drizzle-orm";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@/config";
import { createDb } from "@/db";
import { character } from "@/db/schema";
import { createEsiClient, EsiError } from "@/lib/esi/client";
import { getFreshAccessToken, type CharacterTokenRow } from "@/services/tokens";

function cacheControlLine(cacheControl: string | null): string {
  return cacheControl ?? "absent";
}

function etagLine(etag: string | null): string {
  return etag ? "present" : "absent";
}

/** Never prints `err` itself: it may embed a raw ESI response body. */
function redactedStatus(err: unknown): number | "error" {
  return err instanceof EsiError ? err.status : "error";
}

/**
 * Fixed vocabulary only — every failure reported at this granularity names
 * which of the two non-ESI steps was running, so "FAIL: DrizzleQueryError"
 * (previously the only outcome an uncaught error here ever produced) does
 * not leave a reader guessing whether the database read or the token
 * refresh is what broke. "startup" covers everything before either: config
 * loading, opening the pool, or a failure severe enough to skip both.
 */
type Stage = "startup" | "db-lookup" | "token-refresh";

/**
 * A Postgres SQLSTATE (postgresql.org/docs/current/errcodes-appendix.html)
 * is a fixed five-character code the server assigns from its own published
 * table — never derived from a query, a parameter, or a row this database
 * holds — so it is safe to print even though the driver error carrying it
 * is not (see classifyError). Matched by shape only: some other `.code`
 * (e.g. node-postgres's own "ECONNREFUSED") does not fit this pattern and
 * is deliberately left unrecognized rather than guessed at.
 */
export function isSqlState(code: unknown): code is string {
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code);
}

/**
 * Classifies an outer (non-ESI) failure into safe, fixed-vocabulary text:
 * the error's own constructor name, plus a SQLSTATE if the driver reported
 * one. Deliberately never reads `err.message` — a Drizzle `DrizzleQueryError`
 * IS its raw SQL and bound parameters (drizzle-orm's errors.js builds the
 * message from exactly those two) — nor any property of the underlying
 * node-postgres `DatabaseError` besides `.code`: `.detail`, `.table`,
 * `.column`, `.constraint`, `.hint`, `.where`, and `.internalQuery` can each
 * embed row values, names, or schema (pg-protocol's messages.ts). This is
 * intentionally generic rather than importing `DrizzleQueryError`/
 * `DatabaseError` to narrow the check: the probe fails identically — and
 * this still reports the SQLSTATE — whether pg, pg-boss, or drizzle itself
 * is what threw.
 */
export function classifyError(err: unknown): string {
  if (!(err instanceof Error)) return "unknown error";
  const name = err.constructor.name;
  const cause = err.cause;
  const code =
    cause && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined;
  return isSqlState(code) ? `${name} sqlstate=${code}` : name;
}

/** Reports a fixed stage plus the safe classification above, then exits. */
function failStage(stage: Stage, err: unknown): never {
  console.error(`FAIL: stage=${stage} ${classifyError(err)}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg || !/^[1-9]\d*$/.test(arg) || !Number.isSafeInteger(Number(arg))) {
    console.error(
      "usage: tsx scripts/fleet-esi-feasibility.ts <linked character id>\n" +
        "character id must be a positive integer",
    );
    process.exit(2);
  }
  const characterId = Number(arg);

  const cfg = loadConfig();
  // This probe's entire purpose is to observe LIVE ESI behavior for the fleet
  // scope; SYNC_MODE=dry-run refuses even the token refresh it needs
  // (services/tokens.ts's getFreshAccessToken), so it cannot reach ESI at all
  // under dry-run — and running it there would prove nothing about live
  // feasibility regardless.
  if (cfg.syncMode === "dry-run") {
    console.error(
      "SYNC_MODE=dry-run cannot probe ESI: this check requires a live, " +
        "isolated environment and a consenting test character with " +
        "FLEET_READ_SCOPE granted and (ideally) an active fleet. Re-run with " +
        "SYNC_MODE=live against an isolated environment.",
    );
    process.exit(2);
  }

  const { db, pool } = createDb(cfg.databaseUrl);
  try {
    let row: CharacterTokenRow | undefined;
    try {
      [row] = await db
        .select({
          id: character.id,
          refreshTokenEnc: character.refreshTokenEnc,
          tokenStatus: character.tokenStatus,
        })
        .from(character)
        .where(eq(character.id, characterId));
    } catch (err) {
      failStage("db-lookup", err);
    }
    if (!row) {
      console.error("no linked character found for that id in this environment");
      process.exit(2);
    }

    let token: Awaited<ReturnType<typeof getFreshAccessToken>>;
    try {
      token = await getFreshAccessToken(db, cfg, row);
    } catch (err) {
      // getFreshAccessToken normally reports its own failures via `.ok`
      // (see the branch below); reaching here means something it does NOT
      // catch itself threw — e.g. invalidateTokenIfUnchanged's own query.
      failStage("token-refresh", err);
    }
    if (!token.ok) {
      // token.detail may echo an upstream OAuth error string; token.reason is
      // the stable, safe-to-print classification (no_token/invalid/transient).
      console.error(`could not obtain an access token (${token.reason})`);
      process.exit(1);
    }

    const esi = createEsiClient({ userAgent: `authgd/0.1.0 (${cfg.esiContact})` });

    let exitCode = 0;
    let fleetId: number | null = null;

    try {
      const fleet = await esi.getCharacterFleet(row.id, token.accessToken);
      console.log(
        `character-fleet: ${fleet.status}, ` +
          `cache-control=${cacheControlLine(fleet.cacheControl)}, ` +
          `etag=${etagLine(fleet.etag)}`,
      );
      fleetId = fleet.value.fleetId;
    } catch (err) {
      console.log(
        `character-fleet: ${redactedStatus(err)}, cache-control=absent, etag=absent`,
      );
      exitCode = 1;
    }

    // No fleet id to probe with when the first call did not parse — this is
    // the ONE line the design gets in that case, not a fabricated second one.
    if (fleetId !== null) {
      try {
        const roster = await esi.getFleetMembers(fleetId, token.accessToken);
        console.log(
          `roster: ${roster.status}, ` +
            `cache-control=${cacheControlLine(roster.cacheControl)}, ` +
            `etag=${etagLine(roster.etag)}, members=${roster.value.length}`,
        );
      } catch (err) {
        console.log(
          `roster: ${redactedStatus(err)}, cache-control=absent, etag=absent, members=0`,
        );
        exitCode = 1;
      }
    }

    if (exitCode !== 0) process.exit(exitCode);
  } finally {
    await pool.end();
  }
}

// Compared as RESOLVED paths rather than by filename: an endsWith(...)
// check silently stops running main() if the file is ever renamed or emitted
// as .js, and importing this module for its tested helpers (isSqlState,
// classifyError) would otherwise run main() as a side effect of import, per
// scripts/seed-dev.ts's identical guard.
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err: unknown) => {
    // Reached only for a failure outside the two staged try/catches above —
    // in practice loadConfig, createDb, or pool.end() itself.
    failStage("startup", err);
  });
}
