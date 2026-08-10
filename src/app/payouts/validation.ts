import { z } from "zod";
import { MAX_SHARES_HUNDREDTHS } from "@/services/payouts";
import { iskToCents } from "@/core/payout-split";

/**
 * The `<input type="date">` wire format, parsed strictly. Shared by the two
 * places an operation date arrives (`createOperationAction` and
 * `setOccurredAtAction`) for the same reason `battleReportUrlProblem` is
 * shared: two copies of a check drift.
 *
 * `new Date(...)` alone is not enough. It rejects "not-a-date" and month 13,
 * but it *normalizes* a day past the end of the month rather than refusing it
 * — `new Date("2026-02-30")` is 2026-03-02 — so a hand-built request (the
 * browser's own date picker cannot produce one) would store a different day
 * than it submitted, silently, on a record operators reconcile against their
 * own logs. Comparing the parsed UTC components back against the submitted
 * digits is what catches the rollover; the format guard in front of it is what
 * keeps locale-ish spellings like "2026-2-3" out, since those parse in local
 * time and would shift the stored day by a timezone.
 */
export function parseYmd(raw: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const parsed = new Date(`${y}-${mo}-${d}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  if (
    parsed.getUTCFullYear() !== Number(y) ||
    parsed.getUTCMonth() + 1 !== Number(mo) ||
    parsed.getUTCDate() !== Number(d)
  ) {
    return null;
  }
  return parsed;
}

/**
 * The one definition of what a battle report link is allowed to be: an
 * absolute http(s) URL, or nothing.
 *
 * The rule matters because the value is rendered as a plain `<a href>` on the
 * operation's own page, so a `javascript:` (or `data:`, or any other) scheme
 * reaching the database is stored XSS. `URL.protocol` is lowercase-normalized
 * by the URL spec, so an allowlist compare on it is not case-bypassable, and
 * anything `new URL` cannot parse at all — a bare `zkillboard.com`, say — is
 * not a link this can store either.
 *
 * Extracted rather than written twice. Both entry points need it — the create
 * form and the inline edit on the operation page — and both now RETURN the code
 * rather than redirecting, so the value the operator typed survives the
 * rejection (the loot paste beside the field in the composer's case, the field's
 * own text in the editor's). This returns the code and lets each caller shape it
 * into its own state type. When the two checks were written out separately, the
 * comment in each claiming to match the other went stale inside one change.
 *
 * Returns null when there is nothing to object to, including for a null or
 * empty value — the field is optional at both call sites.
 */
export function battleReportUrlProblem(
  value: string | null,
): "url_invalid" | "url_scheme" | null {
  if (!value) return null;
  let scheme: string;
  try {
    scheme = new URL(value).protocol;
  } catch {
    return "url_invalid";
  }
  return scheme === "http:" || scheme === "https:" ? null : "url_scheme";
}

/**
 * Reads the rejected field's code back off a failed zod parse and proves it is
 * one the destination page's own error map can render — the same "unmapped
 * code fails loudly" property `operationFailed`'s `keyof typeof` parameter
 * already gives every throw-based redirect (`actions.ts`), applied here to a
 * returned parse failure instead. Every schema below carries its code as the
 * issue's own `message` (via `error:`/`ctx.addIssue({ message })`) rather than
 * zod's own generated wording, deliberately: this reader is what proves that
 * carried string is one the caller can actually show, and a schema that typos
 * a code, or a page whose map drops one a schema still emits, throws here at
 * the first parse that hits it rather than silently rendering nothing.
 *
 * Reads `issues[0]` only — first-check-wins, the same convention every schema
 * below is written to preserve (declaration order inside a `z.object`, or
 * `.refine`/`.transform` order inside a single field's own chain).
 */
export function readValidationCode<Code extends string>(
  error: z.ZodError,
  errors: Record<Code, string>,
): Code {
  const code = error.issues[0]?.message;
  if (code === undefined || !Object.hasOwn(errors, code)) {
    throw new Error(`payouts/validation: unmapped code from zod issue: ${String(code)}`);
  }
  return code as Code;
}

/** `NEW_OPERATION_ERRORS`' `name_required`, shared by `createOperationAction`
 *  (as the `name` key of `buildCreateOperationSchema`) and `setNameAction`,
 *  whose `OPERATION_ERRORS` entry carries the same code — see `errors.ts`'s
 *  own docblock for why the two maps stay separate even though this one code
 *  spells identically in both. Expects an already-trimmed string, matching
 *  every field schema below: trimming is `field()`'s caller's job (see
 *  `actions.ts`), not this schema's. */
export const nameFieldSchema = z.string().refine((s) => s.length > 0, {
  error: "name_required",
});

/** Parses to a `Date`, or fails with `date_invalid` — no future check. Shared
 *  by `setOccurredAtAction` directly and by `buildCreateOperationSchema` below
 *  (as its base, with a `date_future` refine layered on top only there): the
 *  detail page's own date editor has no future check (pre-existing gap, out
 *  of scope — see `actions.ts`'s own comment on `setOccurredAtAction`), so
 *  sharing this schema rather than `buildCreateOperationSchema`'s whole
 *  `occurredAt` key is what keeps that gap from silently closing here. */
export const occurredAtFieldSchema = z.string().transform((raw, ctx) => {
  const d = parseYmd(raw);
  if (!d) {
    ctx.addIssue({ code: "custom", message: "date_invalid" });
    return z.NEVER;
  }
  return d;
});

/** `url_invalid` / `url_scheme` are spelled identically in both error maps
 *  (see `errors.ts`), so one schema serves both `createOperationAction` and
 *  `setBattleReportUrlAction`. Expects an already-trimmed string; empty means
 *  "nothing submitted", the same optional-field reading `battleReportUrlProblem`
 *  itself takes. */
export const battleReportUrlFieldSchema = z.string().transform((raw, ctx) => {
  const value = raw || null;
  const problem = battleReportUrlProblem(value);
  if (problem) {
    ctx.addIssue({ code: "custom", message: problem });
    return z.NEVER;
  }
  return value;
});

/**
 * `createOperationAction`'s one schema, folding the name/date/battle-report-url
 * checks that used to be three separate `if`s into a single parse — see that
 * action's own comment for why all three still have to run before the paste is
 * ever appraised. Declared in `name`, `occurredAt`, `battleReportUrl` order
 * because zod (v4) walks a `z.object`'s keys in declaration order and this
 * reader only ever looks at `issues[0]`: that order is what keeps "a blank name
 * plus a bad URL" landing on `name_required`, matching the sequential `if`
 * chain this replaces.
 *
 * A factory rather than a module-level constant because `date_future` depends
 * on the request's own instant — see `createOperationAction`'s comment on why
 * `todayUtc` is computed once per call rather than at import time.
 */
export function buildCreateOperationSchema(todayUtc: Date) {
  return z.object({
    name: nameFieldSchema,
    occurredAt: occurredAtFieldSchema.refine((d) => d.getTime() <= todayUtc.getTime(), {
      error: "date_future",
    }),
    battleReportUrl: battleReportUrlFieldSchema,
  });
}

/** `addFlatPoolAction`'s two required fields — `note_required` before
 *  `total_invalid`, matching the `if` chain this replaces: `notes` declared
 *  first is what keeps a blank note taking priority over a malformed total. */
export const flatPoolFieldSchema = z.object({
  notes: z.string().refine((s) => s.length > 0, { error: "note_required" }),
  totalValue: z
    .string()
    .refine((s) => /^\d+(\.\d{1,2})?$/.test(s), { error: "total_invalid" }),
});

/** `setItemPriceAction`'s one field. Two decimal places, matching numeric(20,2). */
export const unitPriceFieldSchema = z
  .string()
  .refine((s) => /^\d+(\.\d{1,2})?$/.test(s), { error: "price_invalid" });

/** `addParticipantAction`'s one field. `participant_duplicate` is not part of
 *  this schema — it can only be known once the insert itself races against the
 *  roster, so `addParticipantAction` still catches `PayoutDuplicateParticipantError`
 *  after this parse succeeds. */
export const participantNameFieldSchema = z.string().refine((s) => s.length > 0, {
  error: "participant_name_required",
});

/**
 * `setParticipantSharesAction`'s one field, folding all four of its checks
 * into a single chain in the same order the `if` chain this replaces used:
 * `shares_required`, then `shares_invalid` (format), then — only once the
 * format is known to be safe for it — `iskToCents`, whose own
 * `shares_positive` / `shares_range` checks close the chain. The order is load
 * -bearing: `iskToCents` *throws* on anything its own regex rejects
 * (`core/payout-split.ts`), so it must never run on a string the format refine
 * above already rejected — and it does not, because a zod `.transform` does
 * not run once an earlier step in the same chain has already failed (unlike a
 * later `.refine`, which still evaluates against the original input; verified
 * empirically for this codebase's zod v4).
 */
export const sharesFieldSchema = z
  .string()
  .refine((s) => s.length > 0, { error: "shares_required" })
  .refine((s) => /^-?\d+(\.\d{1,2})?$/.test(s), { error: "shares_invalid" })
  .transform((s, ctx) => {
    const cents = iskToCents(s);
    if (cents <= 0n) {
      ctx.addIssue({ code: "custom", message: "shares_positive" });
      return z.NEVER;
    }
    if (cents > MAX_SHARES_HUNDREDTHS) {
      ctx.addIssue({ code: "custom", message: "shares_range" });
      return z.NEVER;
    }
    return s;
  });

/** `setCorpShareAction`'s one field: format before range, matching the `if`
 *  chain this replaces. */
export const corpSharePctFieldSchema = z
  .string()
  .refine((s) => /^\d+(\.\d{1,2})?$/.test(s), { error: "share_format" })
  .refine((s) => Number(s) <= 100, { error: "share_range" });
