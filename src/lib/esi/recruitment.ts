import { z } from "zod";
import { classifyEsiError } from "@/core/errors";
import {
  RECRUITMENT_CATEGORIES,
  RECRUITMENT_SCOPES,
  type RecruitmentCategory,
  type RecruitmentDataset,
  type RecruitmentProvenance,
  type RecruitmentRecord,
  type RecruitmentStatus,
} from "@/core/recruitment-evidence";
import { EsiError, upstreamRetryAt } from "@/lib/esi/client";

export type RecruitmentLimits = {
  timeoutMs: number;
  maxResponseBytes: number;
  maxTotalBytes: number;
  maxRequests: number;
};
const LIMITS: RecruitmentLimits = {
  timeoutMs: 120_000,
  maxResponseBytes: 4 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxRequests: 500,
};
export type RecruitmentCharacterInput = {
  characterId: number;
  name: string;
  accessToken?: string;
  scopes?: readonly string[];
  unavailableStatus?: "unauthorised" | "failed";
};
export type RecruitmentCharacterEvidence = {
  datasets: RecruitmentDataset[];
  provenance: RecruitmentProvenance[];
  records: RecruitmentRecord[];
};
type Payload = RecruitmentRecord["data"];
type Failure =
  | "deadline"
  | "response_limit"
  | "aggregate_limit"
  | "request_limit"
  | "rate_limited"
  | "upstream_failed"
  | "malformed_response"
  | "invalid_pagination"
  | "invalid_cursor"
  | "unavailable_token";
class CollectionReadError extends EsiError {
  constructor(
    readonly code: Failure,
    status = 0,
  ) {
    super(code, status, classifyEsiError(status));
  }
}

// Source numeric lexemes become strings BEFORE a rounded JS number can escape.
// The optional third argument keeps compatibility with our ES2017 TypeScript lib;
// Node 24.15+ (the package engine floor) and Node 26 supply source context.
function parseEvidence(text: string): unknown {
  return JSON.parse(
    text,
    (key: string, value: unknown, context?: { source?: string }) => {
      if (/^(access_token|refresh_token|authorization|cookie)$/i.test(key)) {
        throw new CollectionReadError("malformed_response");
      }
      if (typeof value !== "number") return value;
      if (!context?.source) throw new CollectionReadError("malformed_response");
      return context.source;
    },
  );
}
const integer = z
  .string()
  .regex(/^-?(?:0|[1-9]\d*)$/)
  .max(21);
const id = z.string().regex(/^[1-9]\d{0,19}$/);
const decimal = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/);
const date = z.iso.datetime();
// Validate documented required/optional fields, but preserve unknown fields and
// open enum strings: a new ESI enum is evidence, not an instruction to discard it.
// Source: ESI meta/openapi.json, compatibility 2020-01-01, checked 2026-09-15.
const historySchema = z.array(
  z.looseObject({
    corporation_id: id,
    record_id: id,
    start_date: date,
    is_deleted: z.boolean().optional(),
  }),
);
const journalSchema = z.array(
  z.looseObject({
    id,
    date,
    ref_type: z.string(),
    description: z.string(),
    amount: decimal.optional(),
    balance: decimal.optional(),
    context_id: integer.optional(),
    context_id_type: z.string().optional(),
    first_party_id: integer.optional(),
    second_party_id: integer.optional(),
    reason: z.string().optional(),
    tax: decimal.optional(),
    tax_receiver_id: integer.optional(),
  }),
);
const transactionsSchema = z.array(
  z.looseObject({
    transaction_id: id,
    date,
    location_id: integer,
    type_id: integer,
    unit_price: decimal,
    quantity: integer,
    client_id: integer,
    is_buy: z.boolean(),
    is_personal: z.boolean(),
    journal_ref_id: integer,
  }),
);
const contractsSchema = z.array(
  z.looseObject({
    contract_id: id,
    issuer_id: integer,
    issuer_corporation_id: integer,
    assignee_id: integer,
    acceptor_id: integer,
    type: z.string(),
    status: z.string(),
    for_corporation: z.boolean(),
    availability: z.string(),
    date_issued: date,
    date_expired: date,
    date_accepted: date.optional(),
    date_completed: date.optional(),
    days_to_complete: integer.optional(),
    end_location_id: integer.optional(),
    start_location_id: integer.optional(),
    buyout: decimal.optional(),
    collateral: decimal.optional(),
    price: decimal.optional(),
    reward: decimal.optional(),
    volume: decimal.optional(),
    title: z.string().optional(),
  }),
);
const itemsSchema = z.array(
  z.looseObject({
    record_id: id,
    type_id: integer,
    quantity: integer,
    is_singleton: z.boolean(),
    is_included: z.boolean(),
    raw_quantity: integer.optional(),
  }),
);
const bidsSchema = z.array(
  z.looseObject({ bid_id: id, bidder_id: integer, date_bid: date, amount: decimal }),
);
const assetsSchema = z.array(
  z.looseObject({
    item_id: id,
    type_id: integer,
    quantity: integer,
    location_id: integer,
    location_type: z.string(),
    location_flag: z.string(),
    is_singleton: z.boolean(),
    is_blueprint_copy: z.boolean().optional(),
  }),
);
const skillsSchema = z.looseObject({
  skills: z.array(
    z.looseObject({
      skill_id: integer,
      active_skill_level: integer,
      trained_skill_level: integer,
      skillpoints_in_skill: integer,
    }),
  ),
  total_sp: integer,
  unallocated_sp: integer.optional(),
});
const queueSchema = z.array(
  z.looseObject({
    queue_position: integer,
    skill_id: integer,
    finished_level: integer,
    finish_date: date.optional(),
    start_date: date.optional(),
    level_end_sp: integer.optional(),
    level_start_sp: integer.optional(),
    training_start_sp: integer.optional(),
  }),
);

const HISTORY_LIMITS: Record<RecruitmentCategory, string | null> = {
  "corporation-history": null,
  wallet:
    "Journal: 30 days. Transactions: upstream history duration unspecified; not the transfer journal.",
  contracts:
    "Contracts no older than 30 days or still in progress, where the character is issuer, acceptor or assignee.",
  assets: "Current holdings, not ownership history.",
  skills:
    "Reported trained skills and totals, not training history. May lag completed queue entries until character login; no inferred updates applied.",
  "skill-queue":
    "Configured queue, not historical activity; past finish dates may not yet be reflected in reported skills.",
};
const SCOPES: Record<RecruitmentCategory, string | null> = {
  "corporation-history": null,
  wallet: RECRUITMENT_SCOPES[0],
  contracts: RECRUITMENT_SCOPES[1],
  assets: RECRUITMENT_SCOPES[2],
  skills: RECRUITMENT_SCOPES[3],
  "skill-queue": RECRUITMENT_SCOPES[4],
};
type EndpointResult = {
  rows: Payload[];
  status: RecruitmentStatus;
  note: string;
  provenanceId: string;
};

// Official meta/openapi.json x-rate-limit groups, checked 2026-09-15.
// Public corporationhistory has no modern group. One snapshot uses one SSO app;
// authenticated buckets are therefore group + character, not snapshot-wide.
const RATE_GROUPS: Record<string, string> = {
  wallet: "char-wallet",
  contracts: "char-contract",
  assets: "char-asset",
  skills: "char-detail",
  skillqueue: "char-detail",
};

/** One instance per account snapshot: resource limits span every upstream. */
export function createRecruitmentCollector(
  opts: {
    fetchImpl?: typeof fetch;
    now?: () => number;
    limits?: Partial<RecruitmentLimits>;
    userAgent?: string;
  } = {},
) {
  const limits = { ...LIMITS, ...opts.limits };
  for (const key of Object.keys(LIMITS) as (keyof RecruitmentLimits)[]) {
    if (
      !Number.isSafeInteger(limits[key]) ||
      limits[key] < 1 ||
      limits[key] > LIMITS[key]
    )
      throw new Error("Invalid recruitment collection limit");
  }
  const now = opts.now ?? Date.now;
  const deadline = now() + limits.timeoutMs;
  const signal = AbortSignal.timeout(limits.timeoutMs);
  const fetchImpl = opts.fetchImpl ?? fetch;
  let requests = 0;
  let bytes = 0;
  let esiRetryAt = 0;
  const bucketRetryAt = new Map<string, number>();
  const observedGroups = new Map<string, string>();
  let recordNumber = 0;

  function checkDeadline() {
    if (signal.aborted || now() >= deadline) throw new CollectionReadError("deadline");
  }
  async function withinBudget<T>(work: () => Promise<T>): Promise<T> {
    checkDeadline();
    let abort: () => void = () => {};
    try {
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(new CollectionReadError("deadline"));
        signal.addEventListener("abort", abort, { once: true });
      });
      const value = await Promise.race([work(), cancelled]);
      checkDeadline();
      return value;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  // Shared with refreshEveToken: SSO responses also cannot evade snapshot byte/
  // time limits. Never persist/cache this wrapper's buffered response body.
  const boundedFetch: typeof fetch = async (input, init) => {
    checkDeadline();
    if (requests >= limits.maxRequests) throw new CollectionReadError("request_limit");
    if (bytes >= limits.maxTotalBytes) throw new CollectionReadError("aggregate_limit");
    const url = new URL(input instanceof Request ? input.url : String(input));
    const isEsi = url.origin === "https://esi.evetech.net";
    const route = /^\/characters\/(\d+)\/([^/]+)/.exec(url.pathname);
    const defaultGroup = route ? RATE_GROUPS[route[2]] : undefined;
    const routeKey =
      defaultGroup ?? url.pathname.replace(/^\/characters\/\d+/, "/characters/{id}");
    let group = observedGroups.get(routeKey) ?? defaultGroup;
    const authenticated = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    ).has("authorization");
    // Public routes use an IP bucket, not the character named in their URL.
    const user = authenticated && route ? `character:${route[1]}` : "public";
    const bucketKey = (name: string) => `${user}:${name}`;
    if (
      isEsi &&
      (now() < esiRetryAt ||
        (group && now() < (bucketRetryAt.get(bucketKey(group)) ?? 0)))
    )
      throw new CollectionReadError("rate_limited");
    requests++;
    const requestSignal = init?.signal ? AbortSignal.any([signal, init.signal]) : signal;
    const res = await withinBudget(() =>
      fetchImpl(input, {
        ...init,
        signal: requestSignal,
        redirect: "error",
        cache: "no-store",
      }),
    );
    if (isEsi) {
      // The response group is authoritative; the documented mapping lets the
      // next endpoint in that group be paced before its first request.
      const reportedGroup = res.headers.get("x-ratelimit-group");
      if (reportedGroup && /^[a-zA-Z0-9_-]{1,100}$/.test(reportedGroup)) {
        group = reportedGroup;
        observedGroups.set(routeKey, group);
      }
      const legacyHeaders = new Headers();
      for (const header of ["x-esi-error-limit-remain", "x-esi-error-limit-reset"]) {
        const value = res.headers.get(header);
        if (value !== null) legacyHeaders.set(header, value);
      }
      esiRetryAt = Math.max(esiRetryAt, upstreamRetryAt(legacyHeaders, now()) ?? 0);
      const legacyRemaining = legacyHeaders.get("x-esi-error-limit-remain");
      const legacyReset = legacyHeaders.get("x-esi-error-limit-reset");
      if (
        legacyRemaining !== null &&
        /^\d{1,10}$/.test(legacyRemaining) &&
        Number(legacyRemaining) <= 5 &&
        (legacyReset === null || !/^\d{1,10}$/.test(legacyReset))
      )
        esiRetryAt = Math.max(esiRetryAt, deadline);

      // Ignore cache freshness. Retry-After and low modern budgets constrain
      // this bucket only. Legacy 420 still gates ESI, never SSO or JWKS.
      const retryHeaders = new Headers();
      const retryAfter = res.headers.get("retry-after");
      if (retryAfter !== null) retryHeaders.set("retry-after", retryAfter);
      let retryAt = upstreamRetryAt(retryHeaders, now()) ?? 0;
      const remaining = res.headers.get("x-ratelimit-remaining");
      if (remaining !== null && /^\d{1,8}$/.test(remaining) && Number(remaining) <= 5) {
        const window = /^(?:\d{1,8})\/(\d{1,8})([mh])$/.exec(
          res.headers.get("x-ratelimit-limit") ?? "",
        );
        retryAt = Math.max(
          retryAt,
          window
            ? now() + Number(window[1]) * (window[2] === "m" ? 60_000 : 3_600_000)
            : deadline,
        );
      }
      if (res.status === 420 || res.status === 429)
        retryAt = Math.max(retryAt, now() + 60_000);
      if (group && res.status !== 420) {
        const key = bucketKey(group);
        bucketRetryAt.set(key, Math.max(bucketRetryAt.get(key) ?? 0, retryAt));
      } else {
        esiRetryAt = Math.max(esiRetryAt, retryAt);
      }
    }
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (reader) {
        while (true) {
          const chunk = await withinBudget(() => reader.read());
          if (chunk.done) break;
          size += chunk.value.byteLength;
          bytes += chunk.value.byteLength;
          if (bytes > limits.maxTotalBytes)
            throw new CollectionReadError("aggregate_limit");
          if (size > limits.maxResponseBytes)
            throw new CollectionReadError("response_limit");
          chunks.push(chunk.value);
        }
      }
    } catch (error) {
      void reader?.cancel().catch(() => {});
      throw error;
    } finally {
      reader?.releaseLock();
    }
    const body = Buffer.concat(chunks, size);
    const headers = new Headers(res.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    return new Response(res.status === 204 || res.status === 304 ? null : body, {
      status: res.status,
      headers,
    });
  };

  async function collectCharacter(
    input: RecruitmentCharacterInput,
  ): Promise<RecruitmentCharacterEvidence> {
    if (!Number.isSafeInteger(input.characterId) || input.characterId <= 0)
      throw new Error("Invalid recruitment character");
    const characterId = String(input.characterId);
    const root = `/characters/${characterId}`;
    const evidence: RecruitmentCharacterEvidence = {
      datasets: [],
      provenance: [],
      records: [],
    };

    async function endpoint(
      category: RecruitmentCategory,
      suffix: string,
      schema: z.ZodType,
      key: string | null,
      mode: "single" | "pages" | "cursor" = "single",
    ): Promise<EndpointResult> {
      const provenanceId = `esi-${characterId}-${suffix.replaceAll("/", "-")}`;
      const scope = SCOPES[category];
      evidence.provenance.push({
        id: provenanceId,
        collector: "authGD organisation-controlled collector",
        method: `GET ${root}/${suffix}`,
        toolVersion: "authgd-recruitment-v1",
        sourceKind: scope ? "authenticated-esi" : "public-esi",
        transformations: [
          "All JSON numeric source lexemes encoded as strings without rounding; other payload fields preserved.",
          "Array entries wrapped individually; skills object retained with its totals.",
        ],
      });
      const rows: Payload[] = [];
      let succeeded = false;
      let failure: Failure | undefined;
      let status: RecruitmentStatus = "failed";
      if (scope && (!input.accessToken || !input.scopes?.includes(scope))) {
        return {
          rows,
          status: input.unavailableStatus ?? "unauthorised",
          provenanceId,
          note: `${suffix}: ${input.unavailableStatus ?? "unauthorised"} (unavailable_token); 0 records`,
        };
      }
      let page = 1;
      let pages = 1;
      let cursor: string | undefined;
      const seen = new Set<string>();
      try {
        while (true) {
          const query =
            mode === "pages" ? `?page=${page}` : cursor ? `?from_id=${cursor}` : "";
          const res = await boundedFetch(
            `https://esi.evetech.net${root}/${suffix}${query}`,
            {
              headers: {
                accept: "application/json",
                "x-compatibility-date": "2020-01-01",
                "user-agent": opts.userAgent ?? "authGD recruitment evidence collector",
                ...(scope ? { authorization: `Bearer ${input.accessToken}` } : {}),
              },
            },
          );
          if (res.status !== 200)
            throw new CollectionReadError("upstream_failed", res.status);
          let parsed: unknown;
          try {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(
              await res.arrayBuffer(),
            );
            parsed = schema.parse(parseEvidence(text));
          } catch {
            throw new CollectionReadError("malformed_response");
          }
          checkDeadline();
          const batch = (Array.isArray(parsed) ? parsed : [parsed]) as Payload[];
          const pageHeader = res.headers.get("x-pages");
          const pageCount =
            pageHeader !== null && /^[1-9]\d{0,8}$/.test(pageHeader)
              ? Number(pageHeader)
              : null;
          if (mode === "pages" && page > 1 && (pageCount !== pages || batch.length === 0))
            throw new CollectionReadError("invalid_pagination");
          // Every configured source key is a string validated by its schema.
          const ids = key ? batch.map((row) => row[key] as string) : [];
          if (ids.some((value) => seen.has(value)) || new Set(ids).size !== ids.length)
            throw new CollectionReadError(
              mode === "cursor" ? "invalid_cursor" : "invalid_pagination",
            );
          const previousCursor = cursor;
          if (
            mode === "cursor" &&
            previousCursor &&
            ids.some((value) => BigInt(value) >= BigInt(previousCursor))
          )
            throw new CollectionReadError("invalid_cursor");
          for (const value of ids) seen.add(value);
          succeeded = true;
          rows.push(...batch);
          for (const [index, row] of batch.entries()) {
            evidence.records.push({
              id: `R${++recordNumber}`,
              characterId,
              category,
              provenanceId,
              sourceRecordId: key ? ids[index] : null,
              data: row,
            });
          }
          if (mode === "pages") {
            if (pageCount === null || (pageCount > 1 && batch.length === 0))
              throw new CollectionReadError("invalid_pagination");
            pages = pageCount;
            if (page++ < pages) continue;
          }
          if (mode === "cursor" && batch.length > 0) {
            cursor = ids.reduce((min, value) =>
              BigInt(value) < BigInt(min) ? value : min,
            );
            continue;
          }
          status = rows.length ? "complete" : "empty";
          break;
        }
      } catch (error) {
        failure =
          error instanceof CollectionReadError
            ? error.code
            : signal.aborted
              ? "deadline"
              : "upstream_failed";
        status = succeeded
          ? "partial"
          : error instanceof EsiError && (error.status === 401 || error.status === 403)
            ? "unauthorised"
            : "failed";
      }
      return {
        rows,
        status,
        provenanceId,
        note: `${suffix}: ${status}${failure ? ` (${failure})` : ""}; ${rows.length} records`,
      };
    }

    for (const category of RECRUITMENT_CATEGORIES) {
      const parts: EndpointResult[] = [];
      if (category === "corporation-history")
        parts.push(
          await endpoint(category, "corporationhistory", historySchema, "record_id"),
        );
      if (category === "wallet") {
        parts.push(
          await endpoint(category, "wallet/journal", journalSchema, "id", "pages"),
        );
        parts.push(
          await endpoint(
            category,
            "wallet/transactions",
            transactionsSchema,
            "transaction_id",
            "cursor",
          ),
        );
      }
      if (category === "contracts") {
        const list = await endpoint(
          category,
          "contracts",
          contractsSchema,
          "contract_id",
          "pages",
        );
        parts.push(list);
        for (const contract of list.rows) {
          const contractId = contract.contract_id as string;
          parts.push(
            await endpoint(
              category,
              `contracts/${contractId}/items`,
              itemsSchema,
              "record_id",
            ),
          );
          if (contract.type === "auction")
            parts.push(
              await endpoint(
                category,
                `contracts/${contractId}/bids`,
                bidsSchema,
                "bid_id",
              ),
            );
        }
      }
      if (category === "assets")
        parts.push(await endpoint(category, "assets", assetsSchema, "item_id", "pages"));
      if (category === "skills")
        parts.push(await endpoint(category, "skills", skillsSchema, null));
      if (category === "skill-queue")
        parts.push(await endpoint(category, "skillqueue", queueSchema, "queue_position"));
      const rows = parts.flatMap((part) => part.rows);
      const allDone = parts.every(
        (part) => part.status === "complete" || part.status === "empty",
      );
      const anyDone = parts.some(
        (part) =>
          part.status === "complete" ||
          part.status === "empty" ||
          part.status === "partial",
      );
      const status: RecruitmentStatus = allDone
        ? rows.length
          ? "complete"
          : "empty"
        : anyDone
          ? "partial"
          : parts.every((part) => part.status === "unauthorised")
            ? "unauthorised"
            : "failed";
      const dateKey =
        category === "corporation-history"
          ? "start_date"
          : category === "wallet"
            ? "date"
            : category === "contracts"
              ? "date_issued"
              : null;
      const dates = dateKey
        ? rows
            .map((row) => row[dateKey])
            .filter((value): value is string => typeof value === "string")
            .sort()
        : [];
      evidence.datasets.push({
        characterId,
        category,
        status,
        provenanceId: parts[0].provenanceId,
        history: {
          knownLimit: HISTORY_LIMITS[category],
          earliestReturnedAt: dates[0] ?? null,
        },
        note: `Character name at collection: ${input.name}. Scope: all characters linked to the account at capture, not all alts owned or disclosed. ${parts.map((part) => part.note).join("; ")}. ${category === "contracts" ? "Bids collected for auctions only; detail coverage is limited to contracts returned by the list. " : ""}Collection is sequential and upstream data/cache may change between requests.`,
      });
    }
    return evidence;
  }
  return { collectCharacter, boundedFetch, withinBudget };
}
