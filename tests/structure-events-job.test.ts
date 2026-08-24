import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "@/config";
import { structureEvent } from "@/db/schema";
import { runStructureEventsJob } from "@/jobs/structure-events";
import {
  NOTIFICATIONS_SCOPE,
  type EsiNotification,
  type StructureEventsEsi,
} from "@/lib/esi/client";
import { designateStructureHolder, getStructureHolder } from "@/services/structures";
import { setupTestDb, truncateAll } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";

const CORP = 98000001;
const HOLDER = 90000001;

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());

let holderSeeded = false;
beforeEach(async () => {
  await truncateAll(ctx.db);
  holderSeeded = false;
});

/** Designates a holder pinned to CORP, once per test, lazily on first `run`. */
async function ensureHolder(): Promise<void> {
  if (holderSeeded) return;
  const acc = await seedAccount(ctx.db);
  await seedCharacter(ctx.db, testConfig(), {
    id: HOLDER,
    accountId: acc.id,
    corporationId: CORP,
    scopes: [NOTIFICATIONS_SCOPE],
    tokenStatus: "valid",
    // The helper encrypts this with the test key itself — never pass a
    // pre-encrypted blob (tests/helpers/seed.ts:33-50).
    refreshToken: "refresh",
  });
  await designateStructureHolder(ctx.db, HOLDER, CORP, acc.id);
  holderSeeded = true;
}

/** A minimal notification of the given type, defaulting to structure damage. */
function attack(id: number, over: Partial<EsiNotification> = {}): EsiNotification {
  return {
    notificationId: id,
    type: "StructureUnderAttack",
    timestamp: new Date(Date.UTC(2026, 7, 1, 0, 0, id)),
    text: `structureID: &id001 100000${id}\nsolarsystemID: 30000142\nshieldPercentage: 50.0\n`,
    ...over,
  };
}

const seedOne = () => attack(1);

/** A non-structure notification type, which must never reach the table. */
function mailNotification(): EsiNotification {
  return {
    notificationId: 777,
    type: "MailboxUpdate",
    timestamp: new Date(Date.UTC(2026, 7, 1)),
    text: "",
  };
}

/**
 * A single fetchImpl that serves both callers the job makes: EVE SSO's token
 * endpoint (always succeeds, rotating to a new blob) and the Discord webhook
 * post, which either records its content into `posts` or fails when
 * `postFails` is set.
 */
function buildFetch(opts: { posts?: string[]; postFails?: boolean }): typeof fetch {
  return async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (href.includes("login.eveonline.com")) {
      return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt2" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (opts.postFails) {
      return new Response("boom", { status: 500 });
    }
    const body = init?.body
      ? (JSON.parse(String(init.body)).content as string)
      : undefined;
    if (body && opts.posts) {
      opts.posts.push(body);
    }
    return new Response(null, { status: 204 });
  };
}

async function run(opts: {
  notifications: EsiNotification[];
  posts?: string[];
  cfg?: Config;
  postFails?: boolean;
}) {
  await ensureHolder();
  const esi: StructureEventsEsi = {
    getCharacterNotifications: async () => opts.notifications,
  };
  return runStructureEventsJob({
    db: ctx.db,
    cfg: opts.cfg ?? testConfig(),
    esi,
    fetchImpl: buildFetch({ posts: opts.posts, postFails: opts.postFails }),
  });
}

describe("runStructureEventsJob", () => {
  it("seeds silently on the first poll and sends nothing", async () => {
    const posts: string[] = [];
    const res = await run({ notifications: [attack(1), attack(2)], posts });
    expect(res.status).toBe("ok");
    expect(posts).toHaveLength(0);
    const rows = await ctx.db.select().from(structureEvent);
    expect(rows.map((r) => r.alertStatus)).toEqual(["seeded", "seeded"]);
    expect((await getStructureHolder(ctx.db))?.seededAt).toBeInstanceOf(Date);
  });

  it("alerts only on events new since the seed", async () => {
    const posts: string[] = [];
    await run({ notifications: [attack(1)], posts });
    await run({ notifications: [attack(1), attack(2)], posts });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("under attack");
  });

  it("ignores non-damage notification types entirely", async () => {
    await run({ notifications: [seedOne()] });
    await run({
      notifications: [{ ...attack(9), type: "StructureFuelAlert" }, mailNotification()],
    });
    const rows = await ctx.db.select().from(structureEvent);
    expect(rows.map((r) => r.notificationId)).not.toContain(9);
    expect(rows).toHaveLength(1);
  });

  it("records as seeded, never pending, when no webhook is configured", async () => {
    const cfg = {
      ...testConfig(),
      discord: {
        ...testConfig().discord,
        opsWebhookUrl: undefined,
        structureWebhookUrl: undefined,
      },
    };
    await run({ notifications: [attack(1)], cfg }); // seeds
    await run({ notifications: [attack(1), attack(2)], cfg });
    const rows = await ctx.db.select().from(structureEvent);
    expect(rows.map((r) => r.alertStatus).sort()).toEqual(["seeded", "seeded"]);
    expect(rows.some((r) => r.alertStatus === "sent")).toBe(false);
  });

  it("leaves a row pending and retries it next run when the post fails", async () => {
    await run({ notifications: [attack(1)] }); // seed
    const res = await run({ notifications: [attack(1), attack(2)], postFails: true });
    expect(res.status).toBe("partial");
    let [row] = await ctx.db
      .select()
      .from(structureEvent)
      .where(eq(structureEvent.notificationId, 2));
    expect(row.alertStatus).toBe("pending");

    const posts: string[] = [];
    await run({ notifications: [attack(1), attack(2)], posts });
    expect(posts).toHaveLength(1);
    [row] = await ctx.db
      .select()
      .from(structureEvent)
      .where(eq(structureEvent.notificationId, 2));
    expect(row.alertStatus).toBe("sent");
  });

  it("never posts a pending row belonging to another corporation", async () => {
    await run({ notifications: [attack(1)] }); // seed, corp 98000001
    await ctx.db.insert(structureEvent).values({
      notificationId: 500,
      type: "StructureUnderAttack",
      sentAt: new Date(),
      corporationId: 98000999,
      alertStatus: "pending",
    });
    const posts: string[] = [];
    await run({ notifications: [attack(1), attack(2)], posts });
    expect(posts).toHaveLength(1); // event 2 only, never 500
  });

  it("skips entirely in dry-run without touching the table", async () => {
    const cfg = { ...testConfig(), syncMode: "dry-run" as const };
    const res = await run({ notifications: [attack(1)], cfg });
    expect(res.counts?.skipped).toBe(1);
    expect(await ctx.db.select().from(structureEvent)).toHaveLength(0);
  });

  it("records an event whose body will not parse, and still alerts", async () => {
    await run({ notifications: [attack(1)] });
    const posts: string[] = [];
    await run({
      notifications: [attack(1), { ...attack(2), text: "!!! unparseable" }],
      posts,
    });
    expect(posts).toHaveLength(1);
    const [row] = await ctx.db
      .select()
      .from(structureEvent)
      .where(eq(structureEvent.notificationId, 2));
    expect(row.structureId).toBeNull();
    expect(row.alertStatus).toBe("sent");
  });
});
