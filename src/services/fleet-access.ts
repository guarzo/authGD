import { setTimeout as sleep } from "node:timers/promises";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Config } from "@/config";
import type { Db, DbTx } from "@/db";
import { account, character, fleetAccessCheckGate } from "@/db/schema";
import {
  linkedFleetCharacters,
  type FleetAccessCheck,
  type FleetAccessCode,
} from "@/core/fleet-access";
import {
  createEsiClient,
  EsiError,
  FLEET_READ_SCOPE,
  upstreamRetryAt,
} from "@/lib/esi/client";
import { getFreshAccessToken } from "@/services/tokens";

const EXTERNAL_BUDGET_MS = 15_000;

// Never pass one of these transactions to token refresh: credential settlement
// must remain owned and awaited even when its row lock outlives the HTTP budget.
async function shortTransaction<T>(db: Db, work: (tx: DbTx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
    return work(tx);
  });
}

function snapshot(tx: DbTx, accountId: string) {
  // One statement snapshot for both authorization and linked-character projection.
  return tx
    .select({
      tier: account.tier,
      ch: {
        id: character.id,
        name: character.name,
        ownerHash: character.ownerHash,
        refreshTokenEnc: character.refreshTokenEnc,
        tokenStatus: character.tokenStatus,
        scopes: character.scopes,
      },
    })
    .from(account)
    .leftJoin(character, eq(character.accountId, account.id))
    .where(eq(account.id, accountId));
}

type CheckCharacter = NonNullable<Awaited<ReturnType<typeof snapshot>>[number]["ch"]>;
function authorized(ch: CheckCharacter | undefined): ch is CheckCharacter {
  // needs_reauth can mean a missing unrelated baseline scope. Fleet Read only
  // needs its actual optional grant; keep the token service's normal semantics.
  return (
    !!ch &&
    ch.scopes.includes(FLEET_READ_SCOPE) &&
    !!ch.refreshTokenEnc &&
    ch.tokenStatus !== "invalid" &&
    ch.tokenStatus !== "missing"
  );
}

/** Explicit user-request check. The future caller MUST derive accountId from its session. */
export async function checkFleetAccess(
  db: Db,
  cfg: Config,
  input: { accountId: string; anchorCharacterId: number },
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<FleetAccessCheck> {
  let retryAt: string | null = null;
  const failure = (code: FleetAccessCode): FleetAccessCheck => ({
    code,
    checkedAt: null,
    retryAt,
    characters: [],
  });
  if (!z.uuid().safeParse(input.accountId).success) return failure("not_eligible");
  if (!Number.isSafeInteger(input.anchorCharacterId) || input.anchorCharacterId <= 0) {
    return failure("not_authorized");
  }

  let anchor: CheckCharacter;
  try {
    const before = await shortTransaction(db, (tx) => snapshot(tx, input.accountId));
    if (before[0]?.tier !== "member") return failure("not_eligible");
    const ch =
      before.find((row) => row.ch?.id === input.anchorCharacterId)?.ch ?? undefined;
    if (!authorized(ch)) return failure("not_authorized");
    anchor = ch;

    const claim = await shortTransaction(db, async (tx) => {
      const [won] = await tx
        .insert(fleetAccessCheckGate)
        .values({
          accountId: input.accountId,
          nextAllowedAt: sql`clock_timestamp() + interval '60 seconds'`,
        })
        .onConflictDoUpdate({
          target: fleetAccessCheckGate.accountId,
          set: { nextAllowedAt: sql`clock_timestamp() + interval '60 seconds'` },
          setWhere: sql`${fleetAccessCheckGate.nextAllowedAt} <= clock_timestamp()`,
        })
        .returning();
      if (won) return { admitted: true, gate: won };
      const [gate] = await tx
        .select()
        .from(fleetAccessCheckGate)
        .where(eq(fleetAccessCheckGate.accountId, input.accountId));
      return { admitted: false, gate };
    });
    if (!claim.gate) return failure("identity_changed");
    retryAt = claim.gate.nextAllowedAt.toISOString();
    if (!claim.admitted) return failure("cooldown");
  } catch {
    // DB messages may contain query parameters, including encrypted credentials.
    return failure("service_unavailable");
  }

  const budget = new AbortController();
  const deadline = Date.now() + EXTERNAL_BUDGET_MS;
  const timer = setTimeout(() => budget.abort(), EXTERNAL_BUDGET_MS);
  const expired = () => budget.signal.aborted || Date.now() >= deadline;
  const requireBudget = () => {
    if (expired()) {
      budget.abort();
      budget.signal.throwIfAborted();
    }
  };
  let upstreamBoundary: number | null = null;
  let stage: "refresh" | "membership" | "roster" = "refresh";
  let refreshResponseOk = false;
  let upstreamAborted = false;
  const fetchImpl: typeof fetch = async (url, init) => {
    requireBudget();
    const requestSignal = init?.signal ?? (url instanceof Request ? url.signal : null);
    const signal = requestSignal
      ? AbortSignal.any([budget.signal, requestSignal])
      : budget.signal;
    signal.throwIfAborted();
    try {
      const res = await (deps.fetchImpl ?? fetch)(url, { ...init, signal });
      const boundary = upstreamRetryAt(res.headers, Date.now());
      if (boundary !== null) upstreamBoundary = Math.max(upstreamBoundary ?? 0, boundary);
      if (stage === "refresh" && res.ok) {
        // Reading headers is not a completed refresh. Finish the abortable HTTP
        // body before handing it to the unchanged SSO parser/token service, so
        // body timeouts and later credential-write failures remain distinct.
        const body = await res.arrayBuffer();
        refreshResponseOk = true;
        return new Response(body, { status: res.status, headers: res.headers });
      }
      return res;
    } catch (err) {
      upstreamAborted ||= signal.aborted;
      throw err;
    }
  };

  let result: FleetAccessCheck;
  let tokenSettled = false;
  try {
    // Deliberately NOT raced with the timer. Once SSO rotates, this owns the
    // CAS/invalidation/audit settlement, including arbitrarily long DB locks.
    const token = await getFreshAccessToken(db, cfg, anchor, fetchImpl);
    tokenSettled = true;
    if (!token.ok) {
      if (token.reason === "transient" && token.detail === "concurrent rotation") {
        result = failure("identity_changed");
      } else if (!refreshResponseOk && (expired() || upstreamAborted)) {
        result = failure("timed_out");
      } else {
        // A failed save after a successful refresh is a service failure, NOT
        // a successful rotation or a timeout hiding a persistence failure.
        result = failure(
          token.reason === "no_token"
            ? "not_authorized"
            : token.reason === "invalid"
              ? "authorization_rejected"
              : "service_unavailable",
        );
      }
    } else {
      requireBudget();
      const esi = createEsiClient({
        fetchImpl,
        userAgent: `authgd/0.1.0 (${cfg.esiContact})`,
        syncMode: cfg.syncMode,
        sleep: async (ms) => {
          requireBudget();
          await sleep(ms, undefined, { signal: budget.signal });
          requireBudget();
        },
      });
      stage = "membership";
      const membership = await esi.getCharacterFleet(anchor.id, token.accessToken);
      // This ID becomes the next private request path; reject a parsed but
      // non-positive integer instead of making another upstream request.
      if (membership.value.fleetId <= 0) {
        throw new EsiError("Invalid fleet membership", 200, "permanent");
      }
      requireBudget();
      stage = "roster";
      const roster = await esi.getFleetMembers(
        membership.value.fleetId,
        token.accessToken,
      );
      requireBudget();
      const checkedAt = new Date().toISOString();
      const ids = roster.value.map((ch) => ch.characterId);
      if (!ids.includes(anchor.id)) {
        result = failure("roster_unavailable");
      } else {
        const after = await shortTransaction(db, (tx) => snapshot(tx, input.accountId));
        const current = after.find((row) => row.ch?.id === anchor.id)?.ch ?? undefined;
        if (
          after[0]?.tier !== "member" ||
          !authorized(current) ||
          current.ownerHash !== anchor.ownerHash ||
          current.refreshTokenEnc !== token.tokenEnc
        ) {
          result = failure("identity_changed");
        } else {
          result = {
            code: "checked",
            checkedAt,
            retryAt,
            characters: linkedFleetCharacters(
              after.flatMap((row) =>
                row.ch ? [{ characterId: row.ch.id, characterName: row.ch.name }] : [],
              ),
              ids,
            ),
          };
        }
      }
    }
  } catch (err) {
    // Never log EsiError.message: it contains private endpoint paths/bodies.
    // Token refresh returns upstream failures, but invalidation/audit settlement
    // can throw. Budget expiry must never hide that failed credential write.
    if (!tokenSettled) result = failure("service_unavailable");
    else if (expired() || upstreamAborted) result = failure("timed_out");
    else if (err instanceof EsiError) {
      result = failure(
        err.status === 401 || err.status === 403
          ? "authorization_rejected"
          : err.status === 404 && stage === "membership"
            ? "not_in_fleet"
            : err.status === 420 || err.status === 429 || err.status >= 500
              ? "service_unavailable"
              : "roster_unavailable",
      );
    } else result = failure("service_unavailable");
  } finally {
    clearTimeout(timer);
  }

  // Persist timing only, not fleet IDs, roster history or eligibility. Express
  // the remaining delay relative to DB time to avoid trusting a web host's clock
  // for the shared gate; greatest() never shortens a concurrent check's boundary.
  const remaining = upstreamBoundary === null ? 0 : upstreamBoundary - Date.now();
  if (remaining > 0) {
    try {
      const [gate] = await shortTransaction(db, (tx) =>
        tx
          .update(fleetAccessCheckGate)
          .set({
            nextAllowedAt: sql`greatest(${fleetAccessCheckGate.nextAllowedAt}, clock_timestamp() + ${remaining} * interval '1 millisecond')`,
          })
          .where(eq(fleetAccessCheckGate.accountId, input.accountId))
          .returning(),
      );
      if (!gate) return failure("identity_changed");
      retryAt = gate.nextAllowedAt.toISOString();
      result.retryAt = retryAt;
    } catch {
      return failure("service_unavailable");
    }
  }
  return result;
}
