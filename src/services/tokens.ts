import { and, eq } from "drizzle-orm";
import type { Config } from "@/config";
import type { Db } from "@/db";
import { character } from "@/db/schema";
import { classifyOAuthError } from "@/core/errors";
import { decryptToken, encryptToken } from "@/lib/crypto";
import { EveSsoError, refreshEveToken } from "@/lib/esi/sso";
import { logAudit } from "@/services/audit";

export type CharacterTokenRow = {
  id: number;
  refreshTokenEnc: string | null;
  tokenStatus: "valid" | "invalid" | "needs_reauth" | "missing";
};

export type AccessTokenResult =
  | { ok: true; accessToken: string; tokenEnc: string }
  | { ok: false; reason: "no_token" | "invalid" | "transient"; detail?: string };

/**
 * Marks the token invalid ONLY if the stored blob is still the one this
 * decision was based on — one conditional transaction, auditing only when the
 * guard wins. A miss means the row changed underneath us (rotation, re-auth,
 * or transfer reclaim): the stale decision is discarded.
 */
async function invalidateIfUnchanged(
  db: Db,
  characterId: number,
  expectedEnc: string,
  reason: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(character)
      .set({ tokenStatus: "invalid" })
      .where(
        and(eq(character.id, characterId), eq(character.refreshTokenEnc, expectedEnc)),
      )
      .returning({ id: character.id });
    if (rows.length === 0) return false;
    await logAudit(tx, {
      actor: "system",
      action: "token.invalidated",
      target: String(characterId),
      details: { reason },
    });
    return true;
  });
}

/**
 * Refreshes the character's token and persists the rotated refresh token.
 * Permanent OAuth failures — and malformed stored blobs — mark token_status
 * invalid; transient failures change no state (spec: Error handling).
 */
export async function getFreshAccessToken(
  db: Db,
  cfg: Config,
  ch: CharacterTokenRow,
  fetchImpl: typeof fetch = fetch,
): Promise<AccessTokenResult> {
  if (!ch.refreshTokenEnc || ch.tokenStatus === "invalid" || ch.tokenStatus === "missing") {
    return { ok: false, reason: "no_token" };
  }
  let refreshToken: string;
  try {
    refreshToken = decryptToken(ch.refreshTokenEnc, cfg.tokenEncryptionKey);
  } catch {
    const applied = await invalidateIfUnchanged(db, ch.id, ch.refreshTokenEnc, "malformed_token_blob");
    return applied
      ? { ok: false, reason: "invalid", detail: "malformed_token_blob" }
      : { ok: false, reason: "transient", detail: "concurrent rotation" };
  }
  try {
    const r = await refreshEveToken(cfg, refreshToken, fetchImpl);
    // Compare-and-swap on the blob we read: EVE rotates refresh tokens on
    // every use, so a concurrent job (or a transfer reclaim) may have won the
    // row first. A miss means our whole read is stale — report transient and
    // let the next run work from fresh state; never hand out the stale token.
    const tokenEnc = encryptToken(r.refreshToken, cfg.tokenEncryptionKey);
    const rows = await db
      .update(character)
      .set({ refreshTokenEnc: tokenEnc })
      .where(
        and(eq(character.id, ch.id), eq(character.refreshTokenEnc, ch.refreshTokenEnc)),
      )
      .returning({ id: character.id });
    if (rows.length === 0) {
      return { ok: false, reason: "transient", detail: "concurrent rotation" };
    }
    return { ok: true, accessToken: r.accessToken, tokenEnc };
  } catch (err) {
    if (
      err instanceof EveSsoError &&
      classifyOAuthError(err.oauthError, err.status) === "permanent"
    ) {
      // invalid_grant on the OLD blob says nothing about a token another job
      // rotated in the meantime — the conditional update discards the stale
      // decision atomically (no separate read-then-write window).
      const applied = await invalidateIfUnchanged(
        db,
        ch.id,
        ch.refreshTokenEnc,
        err.oauthError ?? `status_${err.status}`,
      );
      return applied
        ? { ok: false, reason: "invalid", detail: err.oauthError }
        : { ok: false, reason: "transient", detail: "concurrent rotation" };
    }
    return {
      ok: false,
      reason: "transient",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
