import { z } from "zod";
import type { Config } from "@/config";

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
const memberSchema = z.object({ roles: z.array(z.string()) });
const userSchema = z.object({ id: z.string() });

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

export function createDiscordClient(cfg: Config, fetchImpl: typeof fetch = fetch) {
  async function rawRequest(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetchImpl(`${API}${path}`, {
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

  return {
    async getGuildRoles() {
      const path = `/guilds/${guild}/roles`;
      const res = await request(path);
      return parseBody(z.array(roleSchema), res, "GET", path);
    },
    async getBotUserId(): Promise<string> {
      const path = "/users/@me";
      const res = await request(path);
      return (await parseBody(userSchema, res, "GET", path)).id;
    },
    /** null ONLY for Discord code 10007 (Unknown Member — user not in guild).
     * Any other 404 (10004 Unknown Guild = bad config, malformed body) is a
     * permanent error: the role job must fail loudly, not skip everyone. */
    async getGuildMember(userId: string): Promise<{ roles: string[] } | null> {
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
    },
    async addMemberRole(userId: string, roleId: string): Promise<void> {
      await request(`/guilds/${guild}/members/${userId}/roles/${roleId}`, {
        method: "PUT",
      });
    },
    async removeMemberRole(userId: string, roleId: string): Promise<void> {
      await request(`/guilds/${guild}/members/${userId}/roles/${roleId}`, {
        method: "DELETE",
      });
    },
  };
}

export type DiscordClient = ReturnType<typeof createDiscordClient>;
