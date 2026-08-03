# Pull request

<!--
CI already runs typecheck, lint, format:check, build, unit tests and e2e on
every PR. Do not restate that here — the checks tab is the authority. This
template asks only for the things CI cannot tell a reviewer.
-->

## What changed and why

## What CI cannot check

<!--
Redact secrets, credentials, tokens, cookies, and personal data before quoting output.
Real output from anything verified by hand: a live service, a reproduced failure
mode, a manual smoke test. Quote it rather than describing it — nothing is
claimed to pass here that was not actually run.

"Nothing beyond CI" is a legitimate answer for a routine change.
-->

## Deploy notes

<!--
Anything that has to happen in a particular ORDER around the deploy:
  * a new or renamed secret (see docs/ops.md — SYNC_MODE must be set BEFORE the
    deploy that reads it, not with it)
  * a generated drizzle migration, and whether it is safe to run against live
    data while the old code is still serving
  * an fly.toml change: process groups, checks, sizing, release_command

"None" is a fine answer.
-->

## Flags

<!--
Anything found along the way that was not asked for but the reviewer should
know: a latent bug, a wrong comment, an assumption that turned out false, work
deliberately left out of scope.
-->
