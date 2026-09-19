import { readdirSync } from "node:fs";
import { autoImplementMethods } from "next/dist/server/route-modules/app-route/helpers/auto-implement-methods";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as database from "@/db";
import { fleetDevice, fleetDeviceSession, fleetPairingRequest } from "@/db/schema";
import { setupTestDb, truncateAll } from "./helpers/db";
import { pairDevice } from "./helpers/fleet-sharing";
import { seedAccount } from "./helpers/seed";

const root = new URL("../src/app/api/fleet/v1/", import.meta.url);
const paths = readdirSync(root, { recursive: true }).filter(
  (path): path is string => typeof path === "string" && path.endsWith("/route.ts"),
);
const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
  await truncateAll(ctx.db);
  await pairDevice(
    ctx.db,
    (await seedAccount(ctx.db, { tier: "member" })).id,
    new Date(),
  );
});
afterAll(() => ctx.cleanup());
for (const path of paths)
  it.each(methods)(
    `registered v1 ${path} %s is rejection-only before any admission`,
    async (method) => {
      const handlers = (await import(
        /* @vite-ignore */ new URL(path, root).href
      )) as Parameters<typeof autoImplementMethods>[0];
      expect(typeof handlers[method]).toBe("function");
      const routes = autoImplementMethods(handlers);
      const req = new NextRequest(
        `https://auth.example/api/fleet/v1/${path.replace("/route.ts", "")}`,
        { method },
      );
      for (const field of ["headers", "body"])
        Object.defineProperty(req, field, {
          get() {
            throw new Error(`read ${field}`);
          },
        });
      const before = {
        devices: await ctx.db.select().from(fleetDevice),
        sessions: await ctx.db.select().from(fleetDeviceSession),
        pairings: await ctx.db.select().from(fleetPairingRequest),
      };
      const spy = vi.spyOn(database, "getDb").mockImplementation(() => {
        throw new Error("DB access");
      });
      try {
        const result = (await routes[method](req, {
          get params(): Promise<Record<string, string>> {
            throw new Error("params read");
          },
        })) as Response;
        expect(result.status).toBe(400);
        expect(result.headers.get("cache-control")).toBe("no-store");
        expect(await result.text()).toBe(
          method === "HEAD" ? "" : '{"protocol":2,"error":"update_required"}',
        );
      } finally {
        spy.mockRestore();
      }
      expect({
        devices: await ctx.db.select().from(fleetDevice),
        sessions: await ctx.db.select().from(fleetDeviceSession),
        pairings: await ctx.db.select().from(fleetPairingRequest),
      }).toEqual(before);
    },
  );
it("discovers the entire currently registered v1 route inventory", () => {
  expect(paths).toHaveLength(11);
});
