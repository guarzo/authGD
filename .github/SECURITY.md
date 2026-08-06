# Security policy

## Reporting a vulnerability

Report privately through GitHub's
[private vulnerability reporting](https://github.com/guarzo/authGD/security/advisories/new).
Please do not open a public issue for a security problem.

authGD is maintained by one person as a spare-time project. Expect an initial
response within a week rather than within a day.

## Scope

A deployment holds ESI refresh tokens encrypted at rest, a Discord bot token, a
Wanderer ACL API key, and server-side sessions. In scope is anything that could:

- expose or decrypt stored ESI refresh tokens, or leak the Discord or Wanderer
  credentials;
- forge or hijack a session, or bypass the admin guard on `/admin/*`;
- let a non-operator account create, edit, or mark paid a payout operation;
- cause a sync job to write to EVE, Discord, or Wanderer against a deployment
  running `SYNC_MODE=dry-run`.

Out of scope: findings that require an already-compromised host, database, or
`.env`; anything against the reference deployment's infrastructure rather than
this codebase; and misconfiguration of a self-hosted instance that the
[operations guide](../docs/ops.md) documents how to avoid.

## Supported versions

Only the current `main` branch is supported. There are no tagged releases and no
backports.
