import { z } from "zod";
import type { Config } from "@/config";

// Wanderer ACL API — contract confirmed 2026-08-02 against wanderer source
// (access_list_api_controller.ex / access_list_member_api_controller.ex):
//   GET    /api/acls/:aclId               → { data: { ..., members: [...] } }
//   POST   /api/acls/:aclId/members       → { data: {...member} } (name resolved server-side)
//   DELETE /api/acls/:aclId/members/:id   → { ok: true }; 404 = not a member (idempotent)
// :id is the EVE character/corp/alliance id, NOT the member row's UUID. Each
// member carries exactly one of eve_character_id / eve_corporation_id /
// eve_alliance_id; non-character members surface here as characterId: null.

export class WandererError extends Error {
  status?: number;
  transient: boolean;
  constructor(message: string, opts: { status?: number; transient: boolean }) {
    super(message);
    this.status = opts.status;
    this.transient = opts.transient;
  }
}

const eveIdSchema = z.union([z.string().regex(/^\d+$/), z.number().int()]);
const roleSchema = z.enum(["admin", "manager", "member", "viewer", "blocked"]);
// Strict on both axes, fail closed: an unknown role spelling could cost an
// entry its admin protection, and a member with zero/multiple external ids
// violates the documented contract — either rejects the WHOLE read, so the
// job never mutates from a misunderstood ACL.
const memberSchema = z
  .object({
    role: roleSchema,
    eve_character_id: eveIdSchema.nullish(),
    eve_corporation_id: eveIdSchema.nullish(),
    eve_alliance_id: eveIdSchema.nullish(),
  })
  .refine(
    (m) =>
      [m.eve_character_id, m.eve_corporation_id, m.eve_alliance_id].filter(
        (v) => v != null,
      ).length === 1,
    { message: "ACL member must carry exactly one external id" },
  );
const aclSchema = z.object({
  data: z.object({ members: z.array(memberSchema) }),
});

export type AclRole = z.infer<typeof roleSchema>;
export type WandererAclMember = { characterId: number | null; role: AclRole };

export function createWandererClient(cfg: Config, fetchImpl: typeof fetch = fetch) {
  const base = cfg.wanderer.baseUrl.replace(/\/$/, "");
  const aclPath = `/api/acls/${cfg.wanderer.aclId}`;
  const membersPath = `${aclPath}/members`;

  async function rawRequest(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetchImpl(`${base}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${cfg.wanderer.apiKey}`,
          "content-type": "application/json",
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new WandererError(
        `wanderer request failed: ${err instanceof Error ? err.message : String(err)}`,
        { transient: true },
      );
    }
  }

  function assertOk(res: Response, method: string, path: string): Response {
    if (!res.ok) {
      throw new WandererError(`wanderer ${method} ${path} failed (${res.status})`, {
        status: res.status,
        transient: res.status === 429 || res.status >= 500,
      });
    }
    return res;
  }

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    return assertOk(await rawRequest(path, init), init.method ?? "GET", path);
  }

  return {
    async getAclMembers(): Promise<WandererAclMember[]> {
      const res = await request(aclPath);
      return aclSchema.parse(await res.json()).data.members.map((m) => ({
        characterId: m.eve_character_id != null ? Number(m.eve_character_id) : null,
        role: m.role,
      }));
    },
    async addAclMember(characterId: number): Promise<void> {
      // role "viewer" (wanderer's default); name is resolved server-side.
      await request(membersPath, {
        method: "POST",
        body: JSON.stringify({
          member: { eve_character_id: String(characterId), role: "viewer" },
        }),
      });
    },
    async updateAclMemberRole(characterId: number, role: AclRole): Promise<void> {
      // keyed by EVE id, not the member row's UUID
      await request(`${membersPath}/${characterId}`, {
        method: "PUT",
        body: JSON.stringify({ member: { role } }),
      });
    },
    async removeAclMember(characterId: number): Promise<void> {
      const path = `${membersPath}/${characterId}`;
      const res = await rawRequest(path, { method: "DELETE" });
      if (res.status === 404) return; // already not a member — idempotent
      assertOk(res, "DELETE", path);
    },
  };
}

export type WandererClient = ReturnType<typeof createWandererClient>;
