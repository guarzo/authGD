/**
 * Dry-run safety guard.
 *
 * `SYNC_MODE=dry-run` makes every OUTBOUND MUTATION a logged no-op, so a
 * developer running a local worker against real credentials cannot delete
 * their in-game contacts, reconcile a live Wanderer ACL, strip Discord roles,
 * or rotate a production EVE refresh token.
 *
 * The guard is applied at the boundaries a job cannot bypass — the three
 * integration clients, the token-refresh path, and the ops webhook — rather
 * than inside each job, so a destructive call added later is covered the day
 * it is written. Reads are NEVER suppressed: dry-run is not offline mode, and
 * seeing real upstream state is the point of running against real credentials.
 *
 * Authentication is deliberately NOT guarded: the login and link
 * OAuth exchanges mint new credentials from a fresh authorization code and
 * invalidate nothing, and guarding them would break local OAuth testing.
 */

/** True when outbound mutations must be suppressed. */
export function isDryRun(cfg: { syncMode: "live" | "dry-run" }): boolean {
  return cfg.syncMode === "dry-run";
}

/**
 * Records the write dry-run suppressed. Logged rather than silent: a
 * suppressed destructive call is exactly what the developer wants to see.
 */
export function logSuppressedWrite(system: string, description: string): void {
  console.log(`[dry-run] suppressed ${system} write: ${description}`);
}
