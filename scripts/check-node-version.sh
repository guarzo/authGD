#!/usr/bin/env bash
# Asserts the Node major version agrees across the three places that pin it:
#
#   Dockerfile   — what production actually runs
#   .nvmrc       — what CI installs (and what nvm picks up locally)
#   package.json — the `engines` floor
#
# The Dockerfile is the source of truth: it is the only one of the three whose
# value ships. CI runs this so a Node bump that misses a file fails the PR
# rather than being discovered at deploy time.
set -euo pipefail

fail() {
  echo "node version drift: $*" >&2
  exit 1
}

# Every `FROM node:<major>` in the Dockerfile must agree with itself first —
# the multi-stage build has three, and a partial bump is its own bug.
mapfile -t docker_majors < <(grep -oE '^FROM node:[0-9]+' Dockerfile | grep -oE '[0-9]+$' | sort -u)
[ "${#docker_majors[@]}" -eq 0 ] && fail "no 'FROM node:<major>' found in Dockerfile"
[ "${#docker_majors[@]}" -gt 1 ] && fail "Dockerfile pins more than one Node major: ${docker_majors[*]}"
docker_major="${docker_majors[0]}"

nvmrc_major="$(tr -d 'v \t\n' < .nvmrc | cut -d. -f1)"
[ -n "$nvmrc_major" ] || fail ".nvmrc is empty"

engines="$(node -p "require('./package.json').engines?.node ?? ''")"
[ -n "$engines" ] || fail "package.json has no engines.node"
# Only the numeric floor is compared; the range operator (>=) is deliberate.
engines_major="$(printf '%s' "$engines" | grep -oE '[0-9]+' | head -1)"

[ "$docker_major" = "$nvmrc_major" ] ||
  fail "Dockerfile is node:$docker_major but .nvmrc is $nvmrc_major"
[ "$docker_major" = "$engines_major" ] ||
  fail "Dockerfile is node:$docker_major but package.json engines is '$engines'"

echo "node version OK: Dockerfile=$docker_major .nvmrc=$nvmrc_major engines='$engines'"
