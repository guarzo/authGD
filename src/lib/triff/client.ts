import { z } from "zod";
import { chunk } from "@/core/chunk";

const TRIFF_QUOTE_URL = "https://triff.tools/api/market/quote";
const QUOTE_CHUNK = 900;

export class TriffError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export interface TriffClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
}

export type TriffQuote = {
  typeId: number;
  sell: { best: number | null; p05: number | null };
  buy: { best: number | null; p05: number | null };
};

const sideSchema = z
  .object({
    best: z.number().nullable().optional(),
    p05: z.number().nullable().optional(),
  })
  .nullable()
  .optional();

const quoteResponseSchema = z.object({
  types: z.array(
    z.object({
      type_id: z.number().int(),
      sell: sideSchema,
      buy: sideSchema,
    }),
  ),
});

export function createTriffClient(opts: TriffClientOptions = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  function safeParse(data: unknown, status: number): z.infer<typeof quoteResponseSchema> {
    const parsed = quoteResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new TriffError("triff quote: malformed response body", status);
    }
    return parsed.data;
  }

  async function quoteChunk(
    typeIds: number[],
    loc: { stationId?: number; regionId?: number },
  ): Promise<Map<number, TriffQuote>> {
    const params = new URLSearchParams({
      type_ids: typeIds.join(","),
      include_aggregates: "true",
      include_orders: "false",
    });
    if (loc.stationId !== undefined) params.set("station_id", String(loc.stationId));
    if (loc.regionId !== undefined) params.set("region_id", String(loc.regionId));

    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.userAgent) headers["user-agent"] = opts.userAgent;

    let res: Response;
    try {
      res = await fetchImpl(`${TRIFF_QUOTE_URL}?${params.toString()}`, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new TriffError(
        `triff quote request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      throw new TriffError(`triff quote failed (${res.status})`, res.status);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new TriffError("triff quote: malformed response body", res.status);
    }
    const parsed = safeParse(body, res.status);

    const out = new Map<number, TriffQuote>();
    for (const t of parsed.types) {
      out.set(t.type_id, {
        typeId: t.type_id,
        sell: { best: t.sell?.best ?? null, p05: t.sell?.p05 ?? null },
        buy: { best: t.buy?.best ?? null, p05: t.buy?.p05 ?? null },
      });
    }
    return out;
  }

  async function quote(
    typeIds: number[],
    loc: { stationId?: number; regionId?: number },
  ): Promise<Map<number, TriffQuote>> {
    const hasStation = loc.stationId !== undefined;
    const hasRegion = loc.regionId !== undefined;
    if (hasStation === hasRegion) {
      throw new TriffError("triff quote: exactly one of stationId or regionId is required");
    }
    if (typeIds.length === 0) return new Map();

    const result = new Map<number, TriffQuote>();
    for (const ids of chunk(typeIds, QUOTE_CHUNK)) {
      const partial = await quoteChunk(ids, loc);
      for (const [id, q] of partial) result.set(id, q);
    }
    return result;
  }

  return { quote };
}
