import { z } from "zod";
import type { Config } from "@/config";
import { isDryRun, logSuppressedWrite } from "@/lib/sync-mode";

const API = "https://discord.com/api/v10";

export class DiscordApiError extends Error {
  status?: number;
  transient: boolean;
  constructor(message: string, opts: { status?: number; transient: boolean }) {
    super(message);
    this.status = opts.status;
    this.transient = opts.transient;
  }
}

const roleSchema = z.object({
  id: z.string(),
  name: z.string(),
  position: z.number().int(),
  permissions: z.string(),
});
/**
 * `roles` is strict: it is what the job exists to diff, and a body that cannot
 * produce it is a body we must fail on.
 *
 * The name fields are the opposite, and deliberately so. `parseBody` classifies
 * a schema failure as PERMANENT — no retry, the member counts as failed — so a
 * strict field here would turn any future shape change in Discord's member
 * payload into every member's role sync failing, to protect a caption. Each one
 * is nullish (absent, null, or a string are all fine) and then `.catch()`es to
 * null, so a value of the wrong type degrades to "no handle shown" instead of
 * taking the roles with it. Do not tighten these without moving the names out
 * of this call.
 */
const memberSchema = z.object({
  roles: z.array(z.string()),
  /** Guild nickname. Absent for a member who never set one. */
  nick: z.string().nullish().catch(null),
  user: z
    .object({
      /** The stable @handle. */
      username: z.string().nullish().catch(null),
      /** Account-wide display name; the fallback when there is no `nick`. */
      global_name: z.string().nullish().catch(null),
    })
    .nullish()
    .catch(null),
});
const userSchema = z.object({ id: z.string() });
type Member = z.infer<typeof memberSchema>;

/** Malformed bodies are deterministic — fail closed as permanent, never
 * retry-loop. Reads the body here so invalid JSON classifies the same way as
 * a schema failure. */
async function parseBody<T>(
  schema: z.ZodSchema<T>,
  res: Response,
  method: string,
  path: string,
): Promise<T> {
  try {
    return schema.parse(await res.json());
  } catch {
    throw new DiscordApiError(`discord ${method} ${path}: malformed response body`, {
      transient: false,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Discord always sends `retry-after` (seconds, may be fractional) on a real
 * 429. A missing or unparseable value is unexpected, but must not throw or
 * wait forever — 1s is a short, safe default that still backs off rather than
 * hammering the route again immediately.
 *
 * The floor is `> 0`, not `>= 0`, because `Number("")` is `0`, not `NaN`: an
 * empty `retry-after` would otherwise pass a `>= 0` guard and return a 0s
 * backoff — the exact immediate re-hammer this default exists to prevent.
 * A literal `retry-after: 0` is treated the same way, and deliberately: the
 * next attempt is worth one second of patience either way.
 */
function parseRetryAfterSeconds(res: Response): number {
  const header = res.headers.get("retry-after");
  const parsed = header === null ? NaN : Number(header);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * A real 429 that keeps recurring past this many attempts is not something a
 * few more seconds of backoff will fix — either Discord is having a bad day
 * on this route or something is misconfigured. Give up and surface the
 * existing transient `DiscordApiError`: pg-boss's own job-level retry (see
 * the `retry` field `discord-roles.ts` returns) takes over from there, on its
 * own schedule.
 *
 * What this bounds is how long OTHER work waits, not whether it waits: every
 * `getGuildMember` shares one `routeKey` and is serialized through `enqueue`,
 * so each member behind the one currently retrying is already blocked. The
 * cap is what keeps that block to ~seconds inside a single job tick instead
 * of unbounded.
 */
const MAX_429_RETRIES = 3;

/**
 * ~5 minutes. `getGuildRoles` and the bot's own guild member rarely change
 * between runs, but they CAN — an operator fixing role hierarchy or
 * permissions after a misconfiguration is exactly the case
 * `validateRoleConfig` exists to catch, and `botMemberCache` caches a `null`
 * bot member (kicked, not yet re-invited) just as readily as a present one.
 * Caching them delays detecting either recovery by up to this TTL, during
 * which `postOpsWebhook` keeps alerting about an already-fixed condition.
 *
 * Note what this TTL does and does not buy. The scheduled `discord-roles` run
 * is hourly (`"15 * * * *"` in `src/core/schedules.ts`) and fetches the
 * preamble once per run, before the member loop — so for the anchor sweep the
 * entry is always expired by the next tick and the cache neither helps nor
 * costs anything. It earns its keep only when two runs land within the TTL:
 * the account- and discord-user-scoped `discord-roles` jobs that
 * `src/core/dispatch-plan.ts` fans out per outbox event, which cluster. Do not
 * widen this window on the theory that it is saving the sweep a fetch.
 */
const PREAMBLE_TTL_MS = 5 * 60 * 1000;

export function createDiscordClient(cfg: Config, fetchImpl: typeof fetch = fetch) {
  /**
   * Per-bucket rate-limit state, keyed by `routeKey` below (our own path
   * template, NOT Discord's opaque `x-ratelimit-bucket` id — see that
   * function's comment for why). Populated from `x-ratelimit-remaining` /
   * `x-ratelimit-reset-after` on every response that carries them.
   *
   * `buckets`, `chains`, and `globalResetAt` all live in this closure, so
   * this pacing is per-PROCESS, not cluster-wide. `createDiscordClient` is
   * constructed once per worker process (see `src/worker/index.ts`), and the
   * `worker` group runs a single machine, so one closure is the whole picture
   * today. That count is NOT visible in `fly.toml` — machine count is not a
   * field there (`fly scale count` sets it); `docs/ops.md` under "Sizing" is
   * where it is recorded, as "`worker=1`, deliberately." Scaling `worker`
   * past one machine would give each process its own independent view of the
   * buckets and reintroduce uncoordinated bursts across machines — this file
   * does not attempt any cross-process coordination (e.g. via Redis/Postgres)
   * for that case.
   */
  const buckets = new Map<string, { remaining: number; resetAt: number }>();
  /**
   * Set when a response carries `x-ratelimit-scope: global`, which means
   * back off EVERY route, not just the one that got the 429. Checked before
   * every request regardless of its own bucket key.
   */
  let globalResetAt = 0;
  /**
   * Per-bucket-key mutex: chains requests sharing a key so they run one at a
   * time, in call order. This is what makes the plain "wait if remaining is
   * exhausted" check below race-free — without it, several calls fired
   * concurrently could all read "remaining > 0" before any of them has
   * updated it from a response.
   *
   * Note this is NOT the shape of the incident: `discord-roles.ts` awaits
   * `getGuildMember` inside a sequential `for` loop, so that burst was
   * fast-but-serial and `waitForCapacity` alone paces it. The mutex is here
   * for the concurrency no current caller produces but any future one could
   * — two `discord-roles` jobs overlapping, or a `Promise.all` over members —
   * where the un-mutexed check would silently degrade to no pacing at all.
   */
  const chains = new Map<string, Promise<void>>();

  function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prior = chains.get(key) ?? Promise.resolve();
    // Run `task` after `prior` settles either way — a failed request must not
    // permanently jam every later request sharing its bucket key.
    const result = prior.then(task, task);
    chains.set(
      key,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  /**
   * Discord's real bucketing is keyed by an opaque `x-ratelimit-bucket` id
   * that is only known AFTER the first response for a route — useless for
   * gating the FIRST request of a burst, which is exactly what mattered in
   * the incident this fixes (calls landing in a bucket with zero prior
   * responses to learn an id from). Templating the path ourselves instead
   * gives a key usable from the very first call, at the cost of potentially
   * grouping routes together that Discord's real scheme might keep separate.
   * For the small, fixed set of routes this client calls, that's a feature:
   * every `getGuildMember` call, regardless of user id, shares one key, which
   * is what lets the bucket state learned from member #1 correctly pace the
   * wait before member #6.
   */
  function routeKey(method: string, path: string): string {
    const KNOWN_SEGMENTS = new Set(["guilds", "roles", "members", "users", "@me"]);
    const templated = path
      .split("/")
      .map((segment) => (segment === "" || KNOWN_SEGMENTS.has(segment) ? segment : ":id"))
      .join("/");
    // Conservative choice: neither the author nor review could confirm from
    // Discord's docs whether adding a role (PUT) and removing one (DELETE)
    // on this same route share one real bucket or two. Sharing ONE key across
    // both methods risks over-throttling — serializing add/remove calls
    // Discord might actually pace independently — rather than
    // under-throttling, which is the failure mode that caused the incident
    // this file exists to fix. Confirm the real keying later from the
    // `x-ratelimit-bucket` header in production logs (that header is NOT
    // used as the key itself — see the comment above this function for why)
    // before splitting this back into two.
    const ROLE_MUTATION_PATH = "/guilds/:id/members/:id/roles/:id";
    if ((method === "PUT" || method === "DELETE") && templated === ROLE_MUTATION_PATH) {
      return `ROLE_MUTATION ${templated}`;
    }
    return `${method} ${templated}`;
  }

  async function waitForCapacity(key: string): Promise<void> {
    // Loops rather than checking each condition once: sleeping out a BUCKET
    // window can take us past the moment another request on a different key
    // received a global-scoped 429 and opened a global window. A single pass
    // would read `globalResetAt` before that happened and never look again,
    // issuing the request straight into the global throttle. Terminates
    // because each branch sleeps until its own deadline has passed, and a
    // deadline is only ever pushed forward by a fresh 429.
    for (;;) {
      const now = Date.now();
      if (now < globalResetAt) {
        await sleep(globalResetAt - now);
        continue;
      }
      const bucket = buckets.get(key);
      if (bucket && bucket.remaining <= 0 && bucket.resetAt > now) {
        await sleep(bucket.resetAt - now);
        continue;
      }
      return;
    }
  }

  function recordBucketHeaders(key: string, res: Response): void {
    const remainingHeader = res.headers.get("x-ratelimit-remaining");
    const resetAfterHeader = res.headers.get("x-ratelimit-reset-after");
    if (remainingHeader === null || resetAfterHeader === null) return;
    const remaining = Number(remainingHeader);
    const resetAfter = Number(resetAfterHeader);
    // `Number.isFinite`, not `!Number.isNaN`: `Number("Infinity")` is not NaN,
    // and an infinite `resetAt` makes `waitForCapacity` compute an infinite
    // wait, which Node silently clamps to 1ms (with a TimeoutOverflowWarning)
    // — disabling pacing for this key instead of enforcing it. Negative values
    // are rejected for the same reason: they would record an already-expired
    // window as if it were a live one.
    if (!Number.isFinite(remaining) || !Number.isFinite(resetAfter) || resetAfter < 0) {
      return;
    }
    buckets.set(key, { remaining, resetAt: Date.now() + resetAfter * 1000 });
  }

  async function rawRequest(path: string, init: RequestInit = {}): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    const key = routeKey(method, path);
    return enqueue(key, async () => {
      for (let attempt = 0; ; attempt++) {
        await waitForCapacity(key);
        let res: Response;
        try {
          res = await fetchImpl(`${API}${path}`, {
            ...init,
            headers: {
              authorization: `Bot ${cfg.discord.botToken}`,
              "content-type": "application/json",
              ...(init.headers as Record<string, string> | undefined),
            },
            signal: AbortSignal.timeout(30_000),
          });
        } catch (err) {
          throw new DiscordApiError(
            `discord request failed: ${err instanceof Error ? err.message : String(err)}`,
            { transient: true },
          );
        }
        recordBucketHeaders(key, res);
        if (res.status === 429) {
          const retryAfterSec = parseRetryAfterSeconds(res);
          const scope = res.headers.get("x-ratelimit-scope");
          const willRetry = attempt < MAX_429_RETRIES;
          // `scope: global` means Discord is throttling the whole bot token,
          // not just this route — every OTHER bucket needs to back off too,
          // not only the one that happened to receive this 429. Recorded on
          // EVERY 429 including the retry-exhausting one: a global throttle
          // that outlasts three attempts is exactly when the other buckets
          // most need to know, and gating this on `willRetry` would drop it
          // precisely then. `Math.max` so a later, shorter window can never
          // shrink one that is already open.
          if (scope === "global") {
            globalResetAt = Math.max(globalResetAt, Date.now() + retryAfterSec * 1000);
          }
          // Overwrite whatever `recordBucketHeaders` just derived from
          // x-ratelimit-remaining/-reset-after above with the SAME window
          // `retry-after` gives us, rather than trusting both independently.
          // Today Discord's `retry-after` and its reset-after header agree,
          // but nothing guarantees that; if they diverged, the bucket state
          // above and the `sleep` below would be sourced from two different
          // header pairs, and next attempt's `waitForCapacity` could sleep a
          // SECOND time off whichever window is longer. Pinning the bucket
          // to the same `retryAfterSec` we are about to sleep makes the
          // upcoming `waitForCapacity` compute ~0 by construction.
          buckets.set(key, { remaining: 0, resetAt: Date.now() + retryAfterSec * 1000 });
          // The 429 response body/headers are otherwise discarded by
          // `assertOk` below, which is why the production incident this
          // fixes left no trace. Logging here is the diagnostic record —
          // and it runs on the EXHAUSTING attempt too, which is the one an
          // operator investigating a surfaced `failed (429)` needs to see.
          console.error(
            `discord rate limited: ${method} ${path} retry-after=${retryAfterSec}s ` +
              `scope=${scope ?? "route"} attempt=${attempt + 1}/${MAX_429_RETRIES + 1}` +
              (willRetry ? "" : " (retries exhausted)"),
          );
          if (willRetry) {
            // Nothing ever reads a retried response's body, and undici holds
            // the socket until the body is consumed or cancelled. Released
            // deliberately WITHOUT awaiting: under the mocked fetch this
            // suite uses, `cancel()` never settles, and awaiting it hung
            // every 429 retry test. The retry must not be gated on a
            // best-effort cleanup either way.
            void res.body?.cancel().catch(() => undefined);
            await sleep(retryAfterSec * 1000);
            continue;
          }
        }
        return res;
      }
    });
  }

  function assertOk(res: Response, method: string, path: string): Response {
    if (!res.ok) {
      throw new DiscordApiError(`discord ${method} ${path} failed (${res.status})`, {
        status: res.status,
        transient: res.status === 429 || res.status >= 500,
      });
    }
    return res;
  }

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    return assertOk(await rawRequest(path, init), init.method ?? "GET", path);
  }

  const guild = cfg.discord.guildId;

  // The preamble the config-check in `discord-roles.ts` runs on EVERY sweep:
  // the guild's roles, the bot's own user id, and the bot's own guild member
  // (for its current role ids). None of these need a fresh fetch every run —
  // see `PREAMBLE_TTL_MS` above for the tradeoff that caching them accepts.
  let botUserIdCache: string | null = null;
  let guildRolesCache: { roles: z.infer<typeof roleSchema>[]; expiresAt: number } | null =
    null;
  let botMemberCache: { member: Member | null; expiresAt: number } | null = null;

  /** null ONLY for Discord code 10007 (Unknown Member — user not in guild).
   * Any other 404 (10004 Unknown Guild = bad config, malformed body) is a
   * permanent error: the role job must fail loudly, not skip everyone. */
  async function fetchGuildMember(userId: string): Promise<Member | null> {
    const path = `/guilds/${guild}/members/${userId}`;
    const res = await rawRequest(path);
    if (res.status === 404) {
      const body = (await res.json().catch(() => undefined)) as
        { code?: number } | undefined;
      if (body?.code === 10007) return null;
      throw new DiscordApiError(
        `discord GET ${path} failed (404${body?.code !== undefined ? `, code ${body.code}` : ", malformed body"})`,
        { status: 404, transient: false },
      );
    }
    assertOk(res, "GET", path);
    return parseBody(memberSchema, res, "GET", path);
  }

  return {
    async getGuildRoles() {
      if (guildRolesCache && Date.now() < guildRolesCache.expiresAt) {
        return guildRolesCache.roles;
      }
      const path = `/guilds/${guild}/roles`;
      const res = await request(path);
      const roles = await parseBody(z.array(roleSchema), res, "GET", path);
      guildRolesCache = { roles, expiresAt: Date.now() + PREAMBLE_TTL_MS };
      return roles;
    },
    // The bot's own id is fixed for the lifetime of the token — cached
    // indefinitely, no TTL needed (there is no "operator fixed it" case to
    // detect: a bot token doesn't get reissued a new user id).
    async getBotUserId(): Promise<string> {
      if (botUserIdCache !== null) return botUserIdCache;
      const path = "/users/@me";
      const res = await request(path);
      botUserIdCache = (await parseBody(userSchema, res, "GET", path)).id;
      return botUserIdCache;
    },
    async getGuildMember(userId: string): Promise<Member | null> {
      // Only the BOT's own member lookup is cached. Every other member fetch
      // must stay live — the whole point of this call for a real member is
      // to read their CURRENT roles for the diff, and a stale cache there
      // would silently paper over an actual role drift instead of fixing it.
      const isBot = botUserIdCache !== null && userId === botUserIdCache;
      if (isBot && botMemberCache && Date.now() < botMemberCache.expiresAt) {
        return botMemberCache.member;
      }
      const member = await fetchGuildMember(userId);
      if (isBot) {
        botMemberCache = { member, expiresAt: Date.now() + PREAMBLE_TTL_MS };
      }
      return member;
    },
    // Dry-run guarded; the reads above are not, so the role diff stays real.
    async addMemberRole(userId: string, roleId: string): Promise<void> {
      if (isDryRun(cfg)) {
        logSuppressedWrite("discord", `add role ${roleId} to user ${userId}`);
        return;
      }
      await request(`/guilds/${guild}/members/${userId}/roles/${roleId}`, {
        method: "PUT",
      });
    },
    async removeMemberRole(userId: string, roleId: string): Promise<void> {
      if (isDryRun(cfg)) {
        logSuppressedWrite("discord", `remove role ${roleId} from user ${userId}`);
        return;
      }
      await request(`/guilds/${guild}/members/${userId}/roles/${roleId}`, {
        method: "DELETE",
      });
    },
  };
}

export type DiscordClient = ReturnType<typeof createDiscordClient>;
