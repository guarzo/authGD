import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { z } from "zod";

const responseSchema = z
  .object({
    status: z.number().int().min(200).max(599).optional(),
    body: z.unknown().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    hold: z.string().min(1).optional(),
    freshness: z.literal("live").optional(),
  })
  .strict();
const scenarioSchema = z
  .object({
    characters: z.array(
      z
        .object({
          id: z.number().int().positive().safe(),
          name: z.string().min(1),
          ownerHash: z.string().min(1),
          scopes: z.array(z.string()),
          refreshToken: z.string().startsWith("fleet-test-").optional(),
        })
        .strict(),
    ),
    fleetId: z.number().int().positive().safe(),
    fleetBossId: z.number().int().positive().safe(),
    rosterIds: z.array(z.number().int().positive().safe()),
    fleets: z
      .array(
        z
          .object({
            fleetId: z.number().int().positive().safe(),
            fleetBossId: z.number().int().positive().safe(),
            memberIds: z.array(z.number().int().positive().safe()).max(32),
            rosterIds: z.array(z.number().int().positive().safe()).max(32),
            responses: z
              .object({
                membership: responseSchema.optional(),
                roster: responseSchema.optional(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(4)
      .optional(),
    responses: z
      .object({
        token: responseSchema.optional(),
        membership: responseSchema.optional(),
        roster: responseSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type FleetScenario = z.infer<typeof scenarioSchema>;
export interface FixtureConnection {
  url: string;
  token: string;
  worktree: string;
  appUrl: string;
}
export interface ProviderRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
}
export interface ProviderResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}
export interface FixtureSnapshot {
  preloads: Array<{ pid: number; threadId: number }>;
  requests: Array<{ stage: string }>;
  violations: Array<{ source: string; destination: string }>;
  pending: string[];
}

function localOrigin(raw: string): URL {
  const url = new URL(raw);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("[fleet-e2e] fixture channel must be a literal loopback origin");
  }
  return url;
}

export function fleetClient(connection: FixtureConnection) {
  localOrigin(connection.url);
  async function call<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${connection.url}/${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${connection.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
      // Next keeps its own request budget. Fixture holds deliberately remain
      // visible until release/close, even after the app aborts; this independent
      // ceiling keeps a broken control channel from hanging the test runner.
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`[fleet-e2e] ${path}: ${await res.text()}`);
    return (await res.json()) as T;
  }
  return {
    connection,
    health: () => call<{ worktree: string; appUrl: string }>("health"),
    scenario: (value: FleetScenario) => call("scenario", value),
    reset: () => call("reset"),
    release: (name: string) => call("release", { name }),
    relayMode: (
      mode?: "normal" | "capture" | "replay" | "disconnect",
      signal?: AbortSignal,
    ) =>
      call<{ mode: "normal" | "capture" | "replay" | "disconnect" }>(
        "relay-mode",
        mode === undefined ? {} : { mode },
        signal,
      ),
    snapshot: () => call<FixtureSnapshot>("snapshot"),
    provider: (request: ProviderRequest) => call<ProviderResponse>("provider", request),
    picker: () => call<Array<{ id: number; name: string }>>("picker"),
    credentials: (characterId: number) =>
      call<{ accessToken: string; refreshToken: string }>("credentials", { characterId }),
    authorize: (url: string, characterId: number) =>
      call<{ callback: string }>("authorize", { url, characterId }),
    preload: (pid: number, threadId: number) => call("preload", { pid, threadId }),
    violation: (source: string, destination: string) =>
      call("violation", { source, destination }),
    async assertClean() {
      const state = await call<FixtureSnapshot>("snapshot");
      if (state.violations.length)
        throw new Error(`[fleet-e2e] denied egress: ${JSON.stringify(state.violations)}`);
      if (state.pending.length)
        throw new Error(`[fleet-e2e] unreleased responses: ${state.pending.join(", ")}`);
    },
  };
}
export type FleetClient = ReturnType<typeof fleetClient>;

/** Never retain query strings, bodies, headers, codes or tokens in the ledger. */
export function safeDestination(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "non-HTTP socket";
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of req) {
    text += String(chunk);
    if (text.length > 64 * 1024) throw new Error("fixture payload too large");
  }
  return JSON.parse(text || "{}");
}

/** Test-owned state only: no production endpoints and no provider passthrough. */
export async function startFleetFixtures(input: { appUrl: string; worktree: string }) {
  const app = new URL(input.appUrl);
  if (
    !["http:", "https:"].includes(app.protocol) ||
    !["localhost", "127.0.0.1"].includes(app.hostname) ||
    !app.port ||
    app.username ||
    app.password ||
    app.pathname !== "/" ||
    app.search ||
    app.hash
  )
    throw new Error("[fleet-e2e] fixture proxy requires an explicit loopback app origin");
  const appOrigin = app.origin;
  const token = randomBytes(32).toString("hex");
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), alg: "RS256", kid: "fleet-test" };
  let scenario: FleetScenario = {
    characters: [],
    fleetId: 123456,
    fleetBossId: 90000001,
    rosterIds: [],
  };
  const requests: FixtureSnapshot["requests"] = [];
  const violations: FixtureSnapshot["violations"] = [];
  const preloads: FixtureSnapshot["preloads"] = [];
  const held = new Map<string, Set<() => void>>();
  const codes = new Map<string, { characterId: number; challenge: string }>();
  const refreshes = new Map<string, number>();
  const consumedRefreshTokens = new Set<string>();
  const accessTokens = new Map<string, { id: number; scopes: string[] }>();
  let serial = 0;
  let closed = false;
  let relayMode: "normal" | "capture" | "replay" | "disconnect" = "normal";
  const sockets = new Set<Socket>();
  const release = (name: string) => {
    for (const resolve of held.get(name) ?? []) resolve();
    held.delete(name);
  };
  const violation = (source: string, destination: string) =>
    violations.push({ source, destination: safeDestination(destination) });

  async function credentials(characterId: number) {
    const ch = scenario.characters.find((ch) => ch.id === characterId);
    if (!ch) throw new Error("unknown synthetic character");
    const refreshToken = `fleet-test-rotated-${++serial}`;
    refreshes.set(refreshToken, ch.id);
    const accessToken = await new SignJWT({
      name: ch.name,
      owner: ch.ownerHash,
      scp: ch.scopes,
    })
      .setProtectedHeader({ alg: "RS256", kid: "fleet-test" })
      .setIssuer("https://login.eveonline.com")
      .setAudience("EVE Online")
      .setSubject(`CHARACTER:EVE:${ch.id}`)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
    accessTokens.set(accessToken, { id: ch.id, scopes: [...ch.scopes] });
    return { accessToken, refreshToken };
  }

  async function provider(request: ProviderRequest): Promise<ProviderResponse> {
    const url = new URL(request.url);
    let stage: "token" | "jwks" | "membership" | "roster";
    let body: unknown;
    let status = 200;
    const membershipId = Number(url.pathname.split("/")[3]);
    const fleet =
      scenario.fleets?.find((f) =>
        url.pathname.includes("/characters/")
          ? f.memberIds.includes(membershipId)
          : url.pathname === `/latest/fleets/${f.fleetId}/members/`,
      ) ?? scenario;
    if (
      url.href === "https://login.eveonline.com/oauth/jwks" &&
      request.method === "GET"
    ) {
      stage = "jwks";
      body = { keys: [jwk] };
    } else if (
      url.href === "https://login.eveonline.com/v2/oauth/token" &&
      request.method === "POST"
    ) {
      stage = "token";
      const params = new URLSearchParams(request.body);
      let characterId: number | undefined;
      if (
        request.headers?.authorization ===
        `Basic ${Buffer.from("cid:sec").toString("base64")}`
      ) {
        if (params.get("grant_type") === "authorization_code") {
          const code = params.get("code") ?? "";
          const tx = codes.get(code);
          codes.delete(code);
          const challenge = createHash("sha256")
            .update(params.get("code_verifier") ?? "")
            .digest("base64url");
          if (tx?.challenge === challenge) characterId = tx.characterId;
        } else if (params.get("grant_type") === "refresh_token") {
          const refresh = params.get("refresh_token") ?? "";
          if (!consumedRefreshTokens.has(refresh)) {
            characterId =
              refreshes.get(refresh) ??
              scenario.characters.find((ch) => ch.refreshToken === refresh)?.id;
            // Consume before signing awaits; the scenario's seed must not be
            // reusable when the application forgets to persist its rotation.
            if (characterId !== undefined) consumedRefreshTokens.add(refresh);
          }
          refreshes.delete(refresh);
        }
      }
      if (characterId) {
        const result = await credentials(characterId);
        body = {
          access_token: result.accessToken,
          refresh_token: result.refreshToken,
          expires_in: 3600,
          token_type: "Bearer",
        };
      } else {
        status = 400;
        body = { error: "invalid_grant" };
      }
    } else if (
      url.origin === "https://esi.evetech.net" &&
      /^\/latest\/characters\/\d+\/fleet\/$/.test(url.pathname) &&
      request.method === "GET"
    ) {
      stage = "membership";
      const id = Number(url.pathname.split("/")[3]);
      if (scenario.characters.some((ch) => ch.id === id)) {
        body = {
          fleet_id: fleet.fleetId,
          fleet_boss_id: fleet.fleetBossId,
          fleet_job: "fleet_member",
          squad_id: -1,
          wing_id: -1,
        };
      } else {
        status = 404;
        body = { error: "Character is not in a fleet" };
      }
    } else if (
      url.origin === "https://esi.evetech.net" &&
      url.pathname === `/latest/fleets/${fleet.fleetId}/members/` &&
      request.method === "GET"
    ) {
      stage = "roster";
      body = fleet.rosterIds.map((character_id) => ({ character_id }));
    } else {
      violation("server-provider", request.url);
      return { status: 599, body: { error: "denied egress" } };
    }
    requests.push({ stage });
    if (stage === "membership" || stage === "roster") {
      const bearer = request.headers?.authorization ?? "";
      const identity = bearer.startsWith("Bearer ")
        ? accessTokens.get(bearer.slice(7))
        : undefined;
      if (!identity) return { status: 401, body: { error: "invalid token" } };
      if (
        !identity.scopes.includes("esi-fleets.read_fleet.v1") ||
        (stage === "membership" && identity.id !== Number(url.pathname.split("/")[3])) ||
        // Boss authority is independent of command position and checked before
        // response overrides, so a synthetic 200 cannot grant roster access.
        (stage === "roster" && identity.id !== fleet.fleetBossId)
      )
        return { status: 403, body: { error: "forbidden" } };
    }
    const rule =
      stage === "jwks"
        ? undefined
        : stage === "token"
          ? scenario.responses?.token
          : fleet.responses?.[stage];
    // Capture before the hold. Changing anchor/scenario must not rewrite a
    // response already in flight, or the late-result test becomes vacuous.
    const result = structuredClone({
      status: rule?.status ?? status,
      headers:
        rule?.freshness === "live"
          ? {
              Date: new Date().toUTCString(),
              "Cache-Control": `max-age=${stage === "membership" ? 60 : 5}`,
              ...rule.headers,
            }
          : rule?.headers,
      body: rule && "body" in rule ? rule.body : body,
    });
    if (rule?.hold) {
      const name = rule.hold;
      await new Promise<void>((resolve) => {
        const set = held.get(name) ?? new Set();
        set.add(resolve);
        held.set(name, set);
      });
    }
    return result;
  }

  const server = createServer((req, res) => {
    // Chromium's proxy is a backstop for redirect/service-worker paths that
    // browser routing cannot intercept. Only this exact app origin is forwarded;
    // redirects are returned as-is, never followed by the proxy.
    if (req.url?.startsWith("http://")) {
      const target = new URL(req.url);
      if (
        app.protocol !== "http:" ||
        target.origin !== appOrigin ||
        target.username ||
        target.password
      ) {
        violation("browser-proxy", req.url);
        res.writeHead(502).end("denied egress");
        return;
      }
      const upstream = httpRequest(
        target,
        { method: req.method, headers: req.headers },
        (response) => {
          res.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(res);
        },
      );
      upstream.on("error", () => {
        if (!res.destroyed) res.writeHead(502).end("local app unavailable");
      });
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
      return;
    }
    void (async () => {
      if (req.method !== "POST" || req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(403).end("fixture authentication required");
        return;
      }
      const data = await readJson(req);
      let result: unknown = {};
      switch (req.url) {
        case "/health":
          result = { appUrl: appOrigin, worktree: input.worktree };
          break;
        case "/relay-mode": {
          const value = z
            .object({
              mode: z.enum(["normal", "capture", "replay", "disconnect"]).optional(),
            })
            .strict()
            .parse(data);
          if (value.mode !== undefined) relayMode = value.mode;
          result = { mode: relayMode };
          break;
        }
        case "/scenario":
          scenario = scenarioSchema.parse(data);
          break;
        case "/reset":
          if (violations.length || held.size)
            throw new Error("cannot reset unasserted egress or pending responses");
          scenario = {
            characters: [],
            fleetId: 123456,
            fleetBossId: 90000001,
            rosterIds: [],
          };
          relayMode = "normal";
          requests.length = 0;
          codes.clear();
          refreshes.clear();
          consumedRefreshTokens.clear();
          accessTokens.clear();
          break;
        case "/release":
          release(z.object({ name: z.string() }).parse(data).name);
          break;
        case "/snapshot":
          result = { requests, violations, preloads, pending: [...held.keys()] };
          break;
        case "/violation": {
          const value = z
            .object({ source: z.string(), destination: z.string() })
            .parse(data);
          violation(value.source, value.destination);
          break;
        }
        case "/preload":
          preloads.push(
            z
              .object({
                pid: z.number().int().positive(),
                threadId: z.number().int().nonnegative(),
              })
              .parse(data),
          );
          break;
        case "/provider":
          result = await provider(
            z
              .object({
                url: z.string().url(),
                method: z.string(),
                headers: z.record(z.string(), z.string()).optional(),
                body: z.string().optional(),
              })
              .parse(data),
          );
          break;
        case "/picker":
          result = scenario.characters.map(({ id, name }) => ({ id, name }));
          break;
        case "/credentials":
          result = await credentials(
            z.object({ characterId: z.number() }).parse(data).characterId,
          );
          break;
        case "/authorize": {
          const value = z
            .object({ url: z.string().url(), characterId: z.number() })
            .parse(data);
          const url = new URL(value.url);
          if (
            url.origin !== "https://login.eveonline.com" ||
            url.pathname !== "/v2/oauth/authorize" ||
            url.searchParams.get("client_id") !== "cid" ||
            url.searchParams.get("redirect_uri") !== `${appOrigin}/auth/eve/callback` ||
            url.searchParams.get("code_challenge_method") !== "S256" ||
            !url.searchParams.get("state") ||
            !url.searchParams.get("code_challenge") ||
            !scenario.characters.some((ch) => ch.id === value.characterId)
          )
            throw new Error("invalid synthetic authorize request");
          const code = `fleet-test-code-${++serial}`;
          codes.set(code, {
            characterId: value.characterId,
            challenge: url.searchParams.get("code_challenge")!,
          });
          const callback = new URL("/auth/eve/callback", appOrigin);
          callback.searchParams.set("state", url.searchParams.get("state")!);
          callback.searchParams.set("code", code);
          result = { callback: callback.href };
          break;
        }
        default:
          throw new Error("unknown fixture control");
      }
      if (!res.destroyed)
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(result));
    })().catch((error: unknown) => {
      if (!res.destroyed)
        res
          .writeHead(400)
          .end(error instanceof Error ? error.message : "fixture failure");
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("connect", (req, socket, head) => {
    // Playwright's APIRequestContext tunnels even plain HTTP through CONNECT.
    // Only the exact owned app socket is allowed; this is NOT a TLS passthrough
    // to EVE or a general-purpose proxy.
    if (req.url === app.host) {
      const upstream = connect({ host: "127.0.0.1", port: Number(app.port) }, () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      socket.on("close", () => upstream.destroy());
      return;
    }
    violation("browser-proxy", `https://${req.url ?? "unknown"}`);
    socket.end("HTTP/1.1 502 Denied egress\r\n\r\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind");
  const connection: FixtureConnection = {
    ...input,
    appUrl: appOrigin,
    token,
    url: `http://127.0.0.1:${address.port}`,
  };
  const client = fleetClient(connection);
  await client.health();
  return {
    connection,
    client,
    async close() {
      if (closed) return;
      closed = true;
      for (const name of held.keys()) release(name);
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
