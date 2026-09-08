import { describe, expect, it } from "vitest";
import {
  deriveFleetEvidenceWindow,
  deriveFleetPacingBoundary,
  type FleetFreshnessInput,
} from "@/core/fleet-freshness";
import { createEsiClient } from "@/lib/esi/client";

const at = (ms: number) => new Date(Date.UTC(2026, 8, 7, 12) + ms);
const input = (extra: Partial<FleetFreshnessInput> = {}): FleetFreshnessInput => ({
  date: at(0).toUTCString(),
  age: null,
  expires: at(5000).toUTCString(),
  cacheControl: "public, max-age=5",
  requestStartedAt: at(0),
  responseCompletedAt: at(0),
  ...extra,
});
describe("origin-based fleet evidence (not receipt-based cache leases)", () => {
  it("permits a ten-second evidence lease with a five-second upstream cache", () => {
    expect(deriveFleetEvidenceWindow(input())).toEqual({
      observedAt: at(0),
      expiresAt: at(10000),
      nextFetchAt: at(5000),
    });
  });
  it("cached Age replay cannot extend the original hard deadline", () => {
    expect(
      deriveFleetEvidenceWindow(
        input({ age: "4", requestStartedAt: at(4000), responseCompletedAt: at(4000) }),
      ),
    ).toEqual({ observedAt: at(0), expiresAt: at(10000), nextFetchAt: at(5000) });
  });
  it("adds body transit to Age, using the more conservative observation", () => {
    expect(
      deriveFleetEvidenceWindow(
        input({ age: "4", requestStartedAt: at(3000), responseCompletedAt: at(4000) }),
      ),
    ).toEqual({ observedAt: at(-1000), expiresAt: at(9000), nextFetchAt: at(5000) });
  });
  it("long cache creates a gap, not sixty seconds of authority", () => {
    expect(
      deriveFleetEvidenceWindow(
        input({ cacheControl: "max-age=60", expires: at(60000).toUTCString() }),
      ),
    ).toEqual({ observedAt: at(0), expiresAt: at(10000), nextFetchAt: at(60000) });
  });
  it.each<Partial<FleetFreshnessInput>>([
    { date: null },
    { date: "nonsense" },
    { date: at(1000).toUTCString() },
    { age: "bad" },
    { age: "-1" },
    { age: "1.5" },
    { age: "10" },
    { age: "99999999999999999999999" },
    { expires: "nonsense" },
    { expires: at(6000).toUTCString() },
    { expires: at(-1000).toUTCString() },
    { cacheControl: null, expires: null },
    { cacheControl: "max-age=5, max-age=5" },
    { cacheControl: "public, private, max-age=5" },
    { cacheControl: "max-age=bad" },
    { cacheControl: "max-age=5, s-maxage=6" },
    { cacheControl: "max-age=5, stale-while-revalidate=30" },
    { requestStartedAt: at(1000), responseCompletedAt: at(0) },
    { responseCompletedAt: at(10000) },
    { requestStartedAt: new Date(NaN) },
  ])("refuses unusable/ambiguous metadata: %j", (extra) => {
    expect(deriveFleetEvidenceWindow(input(extra))).toBeNull();
  });
  it("uses Date without Age and supports a coherent Expires-only lifetime", () => {
    expect(
      deriveFleetEvidenceWindow(
        input({
          cacheControl: null,
          requestStartedAt: at(4000),
          responseCompletedAt: at(4000),
        }),
      )?.expiresAt,
    ).toEqual(at(10000));
  });
  it.each<[Partial<FleetFreshnessInput>, number]>([
    [{ date: null, expires: null, cacheControl: "max-age=86401" }, 86401000],
    [
      {
        date: null,
        expires: null,
        cacheControl: "max-age=120",
        responseCompletedAt: at(4000),
      },
      124000,
    ],
    [{ age: "bad", cacheControl: "max-age=86401, unknown=1" }, 86401000],
    [{ cacheControl: "max-age=86401, max-age=5" }, 86401000],
    [{ cacheControl: "max-age=bad", expires: at(86401000).toUTCString() }, 86401000],
    [{ cacheControl: "max-age=5, s-maxage=86401" }, 86401000],
    [{ cacheControl: 'max-age="86401"' }, 86401000],
  ])(
    "unusable evidence retains independent uncapped request pacing %j",
    (extra, next) => {
      expect(deriveFleetEvidenceWindow(input(extra))).toBeNull();
      expect(deriveFleetPacingBoundary(input(extra))).toEqual(at(next));
    },
  );
  it("actual ESI envelope captures header metadata and completion after body parsing", async () => {
    let now = at(1000).getTime();
    const esi = createEsiClient({
      now: () => now,
      fetchImpl: async () => {
        const response = new Response(
          JSON.stringify([{ character_id: 42, ship_type_id: 999 }]),
          {
            headers: {
              Date: at(0).toUTCString(),
              Age: "1",
              Expires: at(5000).toUTCString(),
              "Cache-Control": "max-age=5",
            },
          },
        );
        const json = response.json.bind(response);
        response.json = async () => {
          now = at(2000).getTime();
          return json() as Promise<unknown>;
        };
        return response;
      },
    });
    const result = await esi.getFleetMembers(123, "synthetic");
    expect(result).toMatchObject({
      value: [{ characterId: 42 }],
      date: at(0).toUTCString(),
      age: "1",
      expires: at(5000).toUTCString(),
      requestStartedAt: at(1000),
      responseCompletedAt: at(2000),
    });
    expect(deriveFleetEvidenceWindow(result)).toEqual({
      observedAt: at(0),
      expiresAt: at(10000),
      nextFetchAt: at(5000),
    });
  });
});
