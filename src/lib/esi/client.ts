import { z } from "zod";
import { isDryRun, logSuppressedWrite } from "@/lib/sync-mode";
import { chunk } from "@/core/chunk";
import { classifyEsiError, type EsiErrorClass } from "@/core/errors";

const ESI_BASE = "https://esi.evetech.net/latest";
const WRITE_CHUNK = 100; // ESI POST/PUT contacts body limit
const DELETE_CHUNK = 20; // ESI DELETE contacts query limit
const AFFILIATION_MAX = 500;
const RESOLVE_IDS_CHUNK = 500; // ESI POST /universe/ids/ body limit
const NAMES_CHUNK = 1000; // ESI POST /universe/names/ body limit

/**
 * The access-list endpoints are not under the versioned `/latest` base — they
 * are served from the root and select their shape with X-Compatibility-Date
 * instead. First use of that convention in this repo; expect it to spread as
 * CCP retires `/latest`.
 */
const ESI_ROOT = "https://esi.evetech.net";
const COMPATIBILITY_DATE = "2026-08-04";

/**
 * The scope belongs to the token making the call, i.e. the paying operator's
 * own character. Exported so the UI gate, the server action and the docs all
 * spell it identically: a typo here would silently hide the control forever
 * rather than fail.
 */
export const OPEN_WINDOW_SCOPE = "esi-ui.open_window.v1";

/**
 * Deliberately NOT in EVE_SSO_SCOPES: adding it there would flip every
 * character to needs_reauth at the next token-health run. Opt-in per character,
 * read back from `character.scopes`. Exported so the link route, the job's
 * scope check and the page's re-grant prompt spell it identically.
 */
export const ACCESS_LISTS_SCOPE = "esi-access.read_lists.v1";

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
const universeIdsSchema = z.object({
  inventory_types: z
    .array(z.object({ id: z.number().int(), name: z.string() }))
    .optional(),
});
/**
 * `structure_id` is an int64 in ESI. Real structure ids sit around 1e12, well
 * inside Number.MAX_SAFE_INTEGER (~9e15), so a plain `z.number().int()` is
 * safe and matches how every other id in this file is parsed.
 *
 * `station_id` and `structure_id` are mutually exclusive AND both optional: a
 * character in space has neither.
 */
const locationSchema = z.object({
  solar_system_id: z.number().int(),
  station_id: z.number().int().optional(),
  structure_id: z.number().int().optional(),
});
const onlineSchema = z.object({ online: z.boolean() });
const namedSchema = z.object({ name: z.string() });

const accessListIdsSchema = z.object({
  access_lists: z.array(z.object({ id: z.number().int() })).nullish(),
});
// `access` fails OPEN as a plain string: a z.enum would turn CCP adding one
// value into a total read failure for a field nothing branches on. The id key
// is entity-specific on the wire — `character_id`, `corporation_id`,
// `alliance_id` — so each array gets its own schema and the client flattens
// all three to `{ access, id }`. Spelled out rather than generated: three
// literal schemas read better than one clever factory.
const characterMemberSchema = z.object({
  access: z.string(),
  character_id: z.number().int(),
});
const corporationMemberSchema = z.object({
  access: z.string(),
  corporation_id: z.number().int(),
});
const allianceMemberSchema = z.object({
  access: z.string(),
  alliance_id: z.number().int(),
});
const accessListSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string().nullish(),
  membership: z
    .object({
      allow_everyone: z.boolean().nullish(),
      characters: z.array(characterMemberSchema).nullish(),
      corporations: z.array(corporationMemberSchema).nullish(),
      alliances: z.array(allianceMemberSchema).nullish(),
    })
    .nullish(),
});
const universeNamesSchema = z.array(
  z.object({
    id: z.number().int(),
    name: z.string(),
    category: z.string(),
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
export type CharacterLocation = {
  systemId: number;
  stationId: number | null;
  structureId: number | null;
};

export type EsiAccessListMember = { access: string; id: number };
export type EsiAccessList = {
  id: number;
  name: string;
  description: string;
  allowEveryone: boolean;
  characters: EsiAccessListMember[];
  corporations: EsiAccessListMember[];
  alliances: EsiAccessListMember[];
};
export type EsiEntityName = { id: number; name: string; category: string };

export interface EsiClientOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Pause when the remaining ESI error budget is at or below this. */
  errorBudgetFloor?: number;
  /** CCP asks every ESI consumer to identify itself with contact info. */
  userAgent?: string;
  /**
   * Dry-run guard. Unlike the Discord and Wanderer factories this one takes no
   * Config, so the mode arrives here instead. Defaults to "live" so existing
   * callers and tests keep their behavior; the worker passes cfg.syncMode.
   */
  syncMode?: "live" | "dry-run";
}

export function createEsiClient(opts: EsiClientOptions = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const floor = opts.errorBudgetFloor ?? 5;
  const dryRun = isDryRun({ syncMode: opts.syncMode ?? "live" });

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
    init: RequestInit & {
      accessToken?: string;
      /** Endpoints served from the root rather than the /latest base. */
      base?: string;
      /** Send X-Compatibility-Date; the versionless endpoints need it. */
      compatibilityDate?: boolean;
    } = {},
  ): Promise<Response> {
    if (remain <= floor && resetAt > now()) {
      await sleep(resetAt - now());
      remain = Number.POSITIVE_INFINITY;
    }
    const { base, compatibilityDate, accessToken, ...rest } = init;
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(init.headers as Record<string, string> | undefined),
    };
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    if (opts.userAgent) headers["user-agent"] = opts.userAgent;
    if (compatibilityDate) headers["x-compatibility-date"] = COMPATIBILITY_DATE;
    const res = await fetchImpl(`${base ?? ESI_BASE}${path}`, {
      ...rest,
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    const remainHeader = res.headers.get("x-esi-error-limit-remain");
    const resetHeader = res.headers.get("x-esi-error-limit-reset");
    if (remainHeader !== null) {
      const parsed = Number(remainHeader);
      if (Number.isFinite(parsed)) remain = parsed;
    }
    if (resetHeader !== null) {
      const parsed = Number(resetHeader);
      if (Number.isFinite(parsed)) resetAt = now() + parsed * 1000;
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as
        { error?: string } | undefined;
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

  /**
   * Unauthenticated. Names ESI doesn't recognize are simply absent from the
   * map — appraiseLoot turns that into a visible "unresolved" line, never a
   * thrown error, so a partial paste never blocks the rest of it.
   */
  async function resolveIds(names: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const namesChunk of chunk(names, RESOLVE_IDS_CHUNK)) {
      const res = await request("/universe/ids/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(namesChunk),
      });
      const parsed = safeParse(
        universeIdsSchema,
        await res.json(),
        "POST",
        "/universe/ids/",
        res.status,
      );
      for (const t of parsed.inventory_types ?? []) {
        out.set(t.name.toLowerCase(), t.id);
      }
    }
    return out;
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
      const res = await request(`/characters/${characterId}/contacts/?page=${page}`, {
        accessToken,
      });
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
    if (dryRun) {
      logSuppressedWrite(
        "esi",
        `${method} ${contactIds.length} contact(s) for character ${characterId} ` +
          `standing=${standing} labels=[${labelIds.join(",")}]`,
      );
      return;
    }
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

  /**
   * Opens the in-game information window for `targetId` on whichever client
   * the token's character is logged into. Nothing is persisted, at CCP or
   * here: the entire effect is a window appearing. ESI answers 204, or an
   * error if the character is not online — which the caller surfaces as a
   * message rather than a retry.
   *
   * `characterId` is not in the path (the endpoint is scoped by the token);
   * it is carried so the dry-run log names whose client would have opened.
   */
  async function openInformationWindow(
    characterId: number,
    accessToken: string,
    targetId: number,
  ): Promise<void> {
    if (dryRun) {
      logSuppressedWrite(
        "esi",
        `open information window for ${targetId} on character ${characterId}`,
      );
      return;
    }
    await request(`/ui/openwindow/information/?target_id=${targetId}`, {
      method: "POST",
      accessToken,
    });
  }

  /**
   * A read, so it is NOT dry-run gated — `dryRun` above suppresses outbound
   * writes only. Absent station/structure ids map to null, which the formatter
   * renders as "in space".
   */
  async function getLocation(
    characterId: number,
    accessToken: string,
  ): Promise<CharacterLocation> {
    const path = `/characters/${characterId}/location/`;
    const res = await request(path, { accessToken });
    const parsed = safeParse(locationSchema, await res.json(), "GET", path, res.status);
    return {
      systemId: parsed.solar_system_id,
      stationId: parsed.station_id ?? null,
      structureId: parsed.structure_id ?? null,
    };
  }

  async function getOnline(characterId: number, accessToken: string): Promise<boolean> {
    const path = `/characters/${characterId}/online/`;
    const res = await request(path, { accessToken });
    return safeParse(onlineSchema, await res.json(), "GET", path, res.status).online;
  }

  /** Unauthenticated: solar-system names are public and effectively immutable. */
  async function getSystemName(systemId: number): Promise<string> {
    const path = `/universe/systems/${systemId}/`;
    const res = await request(path);
    return safeParse(namedSchema, await res.json(), "GET", path, res.status).name;
  }

  /** Unauthenticated: NPC station names are public and effectively immutable. */
  async function getStationName(stationId: number): Promise<string> {
    const path = `/universe/stations/${stationId}/`;
    const res = await request(path);
    return safeParse(namedSchema, await res.json(), "GET", path, res.status).name;
  }

  /**
   * Authenticated, and needs `esi-universe.read_structures.v1` on top of the
   * token. A character without that scope, or without docking access there,
   * gets 403 — which `classifyEsiError` classifies and `request` throws as an
   * EsiError. The caller catches it and renders "Docked", unnamed; nothing is
   * swallowed here.
   */
  async function getStructureName(
    structureId: number,
    accessToken: string,
  ): Promise<string> {
    const path = `/universe/structures/${structureId}/`;
    const res = await request(path, { accessToken });
    return safeParse(namedSchema, await res.json(), "GET", path, res.status).name;
  }

  /**
   * Ids only — each list's name costs a separate detail call, which is why the
   * job caches the catalog rather than re-reading names every run.
   */
  async function getAccessLists(
    characterId: number,
    accessToken: string,
  ): Promise<number[]> {
    const path = `/characters/${characterId}/access-lists`;
    const res = await request(path, {
      accessToken,
      base: ESI_ROOT,
      compatibilityDate: true,
    });
    const parsed = safeParse(
      accessListIdsSchema,
      await res.json(),
      "GET",
      path,
      res.status,
    );
    return (parsed.access_lists ?? []).map((entry) => entry.id);
  }

  /**
   * A 403 here is a normal state, not a fault: it means the holder can no
   * longer see this list. The caller classifies it; nothing is swallowed.
   */
  async function getAccessList(
    characterId: number,
    accessListId: number,
    accessToken: string,
  ): Promise<EsiAccessList> {
    const path = `/characters/${characterId}/access-lists/${accessListId}`;
    const res = await request(path, {
      accessToken,
      base: ESI_ROOT,
      compatibilityDate: true,
    });
    const parsed = safeParse(accessListSchema, await res.json(), "GET", path, res.status);
    const m = parsed.membership;
    return {
      id: parsed.id,
      name: parsed.name,
      description: parsed.description ?? "",
      allowEveryone: m?.allow_everyone ?? false,
      characters: (m?.characters ?? []).map((c) => ({
        access: c.access,
        id: c.character_id,
      })),
      corporations: (m?.corporations ?? []).map((c) => ({
        access: c.access,
        id: c.corporation_id,
      })),
      alliances: (m?.alliances ?? []).map((a) => ({
        access: a.access,
        id: a.alliance_id,
      })),
    };
  }

  /**
   * Unauthenticated batch id→name resolve, chunked like resolveIds. ESI rejects
   * the whole chunk if any id in it is unknown, so an unresolvable id costs the
   * names of its chunkmates too; callers treat a missing name as "render the
   * number" rather than failing the run.
   */
  async function getUniverseNames(ids: number[]): Promise<EsiEntityName[]> {
    const out: EsiEntityName[] = [];
    for (const idsChunk of chunk(ids, NAMES_CHUNK)) {
      const res = await request("/universe/names/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(idsChunk),
      });
      out.push(
        ...safeParse(
          universeNamesSchema,
          await res.json(),
          "POST",
          "/universe/names/",
          res.status,
        ),
      );
    }
    return out;
  }

  return {
    postAffiliation,
    resolveIds,
    openInformationWindow,
    getContactLabels,
    getAllContacts,
    getLocation,
    getOnline,
    getSystemName,
    getStationName,
    getStructureName,
    getAccessLists,
    getAccessList,
    getUniverseNames,
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
      if (dryRun) {
        logSuppressedWrite(
          "esi",
          `DELETE ${contactIds.length} contact(s) for character ${characterId}: ` +
            `[${contactIds.join(",")}]`,
        );
        return;
      }
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

/** The job's narrow view, per ContactsEsi: reads only, no writes reachable. */
export type AccessListsEsi = Pick<
  EsiClient,
  "getAccessLists" | "getAccessList" | "getUniverseNames"
>;
