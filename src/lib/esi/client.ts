import { z } from "zod";
import { chunk } from "@/core/chunk";
import { classifyEsiError, type EsiErrorClass } from "@/core/errors";

const ESI_BASE = "https://esi.evetech.net/latest";
const WRITE_CHUNK = 100; // ESI POST/PUT contacts body limit
const DELETE_CHUNK = 20; // ESI DELETE contacts query limit
const AFFILIATION_MAX = 500;

export class EsiError extends Error {
  status: number;
  kind: EsiErrorClass;
  constructor(message: string, status: number, kind: EsiErrorClass) {
    super(message);
    this.status = status;
    this.kind = kind;
  }
}

const affiliationSchema = z.array(
  z.object({
    character_id: z.number().int(),
    corporation_id: z.number().int(),
    alliance_id: z.number().int().optional(),
  }),
);
const labelsSchema = z.array(
  z.object({ label_id: z.number().int(), label_name: z.string() }),
);
const contactsSchema = z.array(
  z.object({
    contact_id: z.number().int(),
    contact_type: z.string(),
    standing: z.number(),
    label_ids: z.array(z.number().int()).nullish(),
  }),
);

export type Affiliation = {
  characterId: number;
  corporationId: number;
  allianceId: number | null;
};
export type EsiContact = {
  contactId: number;
  contactType: string;
  standing: number;
  labelIds: number[];
};

export interface EsiClientOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Pause when the remaining ESI error budget is at or below this. */
  errorBudgetFloor?: number;
}

export function createEsiClient(opts: EsiClientOptions = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const floor = opts.errorBudgetFloor ?? 5;

  // ESI etiquette: honor X-ESI-Error-Limit-Remain/Reset across all calls.
  let remain = Number.POSITIVE_INFINITY;
  let resetAt = 0; // epoch ms

  function safeParse<T>(
    schema: z.ZodSchema<T>,
    data: unknown,
    method: string,
    path: string,
    status: number,
  ): T {
    try {
      return schema.parse(data);
    } catch {
      throw new EsiError(
        `ESI ${method} ${path}: malformed response body`,
        status,
        "permanent",
      );
    }
  }

  async function request(
    path: string,
    init: RequestInit & { accessToken?: string } = {},
  ): Promise<Response> {
    if (remain <= floor && resetAt > now()) {
      await sleep(resetAt - now());
      remain = Number.POSITIVE_INFINITY;
    }
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(init.headers as Record<string, string> | undefined),
    };
    if (init.accessToken) headers.authorization = `Bearer ${init.accessToken}`;
    const res = await fetchImpl(`${ESI_BASE}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    const remainHeader = res.headers.get("x-esi-error-limit-remain");
    const resetHeader = res.headers.get("x-esi-error-limit-reset");
    if (remainHeader !== null) remain = Number(remainHeader);
    if (resetHeader !== null) resetAt = now() + Number(resetHeader) * 1000;
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as
        | { error?: string }
        | undefined;
      throw new EsiError(
        `ESI ${init.method ?? "GET"} ${path} failed (${res.status}${body?.error ? `: ${body.error}` : ""})`,
        res.status,
        classifyEsiError(res.status, body),
      );
    }
    return res;
  }

  async function postAffiliation(ids: number[]): Promise<Affiliation[]> {
    if (ids.length === 0) return [];
    if (ids.length > AFFILIATION_MAX) {
      throw new Error(`postAffiliation: max ${AFFILIATION_MAX} ids per call`);
    }
    const res = await request("/characters/affiliation/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ids),
    });
    return safeParse(
      affiliationSchema,
      await res.json(),
      "POST",
      "/characters/affiliation/",
      res.status,
    ).map((a) => ({
      characterId: a.character_id,
      corporationId: a.corporation_id,
      allianceId: a.alliance_id ?? null,
    }));
  }

  async function getContactLabels(
    characterId: number,
    accessToken: string,
  ): Promise<Array<{ labelId: number; labelName: string }>> {
    const res = await request(`/characters/${characterId}/contacts/labels/`, {
      accessToken,
    });
    return safeParse(
      labelsSchema,
      await res.json(),
      "GET",
      `/characters/${characterId}/contacts/labels/`,
      res.status,
    ).map((l) => ({ labelId: l.label_id, labelName: l.label_name }));
  }

  /** Reads ALL pages; any page failure rejects the whole call. */
  async function getAllContacts(
    characterId: number,
    accessToken: string,
  ): Promise<EsiContact[]> {
    const first = await request(`/characters/${characterId}/contacts/?page=1`, {
      accessToken,
    });
    // Fail closed: an unknown page count means an unknown contact set, and the
    // downstream diff deletes. Never guess (spec: never remove on unknown state).
    const pagesHeader = first.headers.get("x-pages");
    const pages = Number(pagesHeader);
    if (pagesHeader === null || !Number.isInteger(pages) || pages < 1) {
      throw new EsiError(
        `ESI GET contacts: missing or invalid X-Pages header (${pagesHeader})`,
        0,
        "transient",
      );
    }
    const raw = safeParse(
      contactsSchema,
      await first.json(),
      "GET",
      `/characters/${characterId}/contacts/?page=1`,
      first.status,
    ).slice();
    for (let page = 2; page <= pages; page++) {
      const res = await request(
        `/characters/${characterId}/contacts/?page=${page}`,
        { accessToken },
      );
      raw.push(
        ...safeParse(
          contactsSchema,
          await res.json(),
          "GET",
          `/characters/${characterId}/contacts/?page=${page}`,
          res.status,
        ),
      );
    }
    return raw.map((c) => ({
      contactId: c.contact_id,
      contactType: c.contact_type,
      standing: c.standing,
      labelIds: c.label_ids ?? [],
    }));
  }

  function contactWriteParams(standing: number, labelIds: number[]): string {
    const params = new URLSearchParams({ standing: String(standing) });
    for (const l of labelIds) params.append("label_ids", String(l));
    return params.toString();
  }

  async function writeContacts(
    method: "POST" | "PUT",
    characterId: number,
    accessToken: string,
    contactIds: number[],
    standing: number,
    labelIds: number[],
  ): Promise<void> {
    for (const ids of chunk(contactIds, WRITE_CHUNK)) {
      await request(
        `/characters/${characterId}/contacts/?${contactWriteParams(standing, labelIds)}`,
        {
          method,
          accessToken,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(ids),
        },
      );
    }
  }

  return {
    postAffiliation,
    getContactLabels,
    getAllContacts,
    addContacts: (
      characterId: number,
      accessToken: string,
      contactIds: number[],
      standing: number,
      labelIds: number[],
    ) => writeContacts("POST", characterId, accessToken, contactIds, standing, labelIds),
    editContacts: (
      characterId: number,
      accessToken: string,
      contactIds: number[],
      standing: number,
      labelIds: number[],
    ) => writeContacts("PUT", characterId, accessToken, contactIds, standing, labelIds),
    deleteContacts: async (
      characterId: number,
      accessToken: string,
      contactIds: number[],
    ): Promise<void> => {
      for (const ids of chunk(contactIds, DELETE_CHUNK)) {
        await request(
          `/characters/${characterId}/contacts/?contact_ids=${ids.join(",")}`,
          { method: "DELETE", accessToken },
        );
      }
    },
  };
}

export type EsiClient = ReturnType<typeof createEsiClient>;
