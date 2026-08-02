# Carry-over notes for Plans 2 and 3 (from Plan 1 final review, 2026-08-02)

Plan 1 (Foundation & Auth) merged clean; these notes bind later plans.

## Hard precondition for Plan 2

- **Advisory-lock namespacing:** `src/services/accounts.ts` uses the single-int
  `pg_advisory_xact_lock(characterId)` global keyspace. Before Plan 2 introduces any
  other advisory lock (outbox dispatcher, job leader election), migrate to the two-arg
  `pg_advisory_xact_lock(namespace, id)` form everywhere.

## Plan 2 notes

- `src/lib/discord/oauth.ts` blind-casts token/user JSON; tighten to fail-closed
  validation (mirror `src/lib/esi/sso.ts`) when the Discord surface grows —
  `user.id` feeds a unique identity column.
- Add purge jobs for expired `session` and consumed/expired `oauth_transaction` rows.
- `decryptToken` throws uncleanly on malformed blobs — first runtime caller is
  Plan 2's token refresh; consider a clean validation error there.
- Zero-character accounts keep live sessions (product question; revisit with
  cryo/status work).

## Plan 3 notes

- `demoteAdmin` has no actor-authorization check — Plan 3 admin routes must gate it,
  and should add `ORDER BY account.id` to its multi-row `FOR UPDATE`.
- Bootstrap recovery caveat for operator docs: the bootstrap grant is once-ever per
  character id; last-admin recovery requires an id that has never been granted.
- Login page accepts but ignores an `error` search param — wire or drop during UI
  polish.
