# fleet-v1 signed-request protocol

The wire contract between a paired Wingman device and authGD's fleet relay
(`src/services/fleet-relay.ts`, `src/services/fleet-pairing.ts`,
`src/lib/fleet-signature.ts`, `src/lib/fleet-route-auth.ts`,
`src/app/api/fleet/v1/*`). Read this before implementing or changing a
client against these routes — it states the rules a client must follow that
are not obvious from any single route file, most importantly the one this
document exists to pin down: **a device may have at most one fleet-v1
signed request in flight at a time.**

## Routes

| Method | Path                                     | Signed? | Purpose                                             |
| ------ | ----------------------------------------- | ------- | ---------------------------------------------------- |
| POST   | `/api/fleet/v1/pairing-requests`          | no      | Register a candidate device key, open a pairing request. |
| POST   | `/api/fleet/v1/pairing-requests/:id/complete` | no  | Prove key possession, consume the request, mint a session. |
| GET    | `/api/fleet/v1/catalogue`                 | yes     | This device's own account's linked-character catalogue. |
| PUT    | `/api/fleet/v1/snapshot`                  | yes     | Atomically replace this device's sparse DPS/EWAR projection. |
| GET    | `/api/fleet/v1/snapshot`                  | yes     | The flat union of rows from the requester's own eligible fleets. |
| PUT    | `/api/fleet/v1/session`                   | yes     | Extend this device's OWN session in place — no new browser approval, no new session id. |

Pairing is deliberately unauthenticated (Global Constraint): there is no
session yet to sign with. Every route below that line requires all five
`X-Fleet-*` headers and is rejected outright if the request URL carries a
query string (`hasUnsignedQueryString`) — the signature only ever covers a
bare canonical path.

## The five signed headers

`X-Fleet-Session`, `X-Fleet-Issued-At`, `X-Fleet-Revision`,
`X-Fleet-Body-SHA256`, `X-Fleet-Signature` — see `fleet-signature.ts` for
their exact shapes and `canonicalFleetRequest`'s byte-for-byte construction.
A GET carries an empty body and still signs its (empty) digest, the same
convention `PUT /session` uses for its own empty body.

## Negotiated snapshot freshness (`publication-v1`)

Only `GET /api/fleet/v1/snapshot` accepts the optional request header
`X-Fleet-Snapshot-Format: publication-v1`. The signed canonical bytes and five
signed headers above do **not** change. The format is one HTTP token: unknown
valid tokens return `400 update_required`; empty, duplicate/comma-joined or
malformed values return `400 bad_headers`. No query selectors or GET body are
accepted. Authentication and transactional admission still apply. Snapshot GET
requires absent `Content-Length` or a decimal zero value, and no
`Transfer-Encoding`. Next's Node adapter discards GET streams while preserving
these headers, so stream length alone cannot enforce the empty-body contract.
Malformed framing that Node's HTTP parser rejects never reaches the JSON route.

On an admitted negotiated read, the response has:

- `X-Fleet-Snapshot-Format: publication-v1`
- `X-Fleet-Request-Binding: <64 lowercase SHA256 hex>`
- `Cache-Control: no-store`

The binding is `SHA256(UTF8("fleet-snapshot-publication-v1\n") || C)`, where `C`
is the **unchanged, authenticated** fleet-v1 canonical request byte sequence,
with no added trailing newline. It binds the literal method/path, session,
original issued-at spelling, canonical base-10 revision and lowercase body digest.
The server reconstructs it; a caller-supplied response-binding header is not used.
`tests/fixtures/fleet-snapshot-publication-v1.json` is shared byte-for-byte with
Wingman and pins two cross-language vectors and every canonical field's influence.

JSON remains `{protocol:1,rows:[...]}`. Each negotiated row contains the original
six fields (`character_id`, `character_name`, `dps`, `ewar`, `state`, `age_ms`) plus
required `publication_id`: a canonical lowercase UUIDv4. Every accepted PUT,
including an unchanged legacy desktop PUT or equal metrics, stamps a new,
independent ID **per row**. One batch never intentionally shares an ID. Refused
batches and reads do not change row IDs, timestamps or leases. Withdrawal deletes
the row; a later publication has a new ID. These opaque IDs disclose no raw
source/account/session provenance.

Migration `0024_fleet_publication_id` adds a nullable UUID column only: no default,
backfill or index. Existing null-ID rows are withheld from negotiated serialization,
not stamped on read. Without opt-in, the exact legacy JSON shape remains unchanged
and neither extension response header is sent. Error responses never send success
extension headers. PUT body, catalogue, consent and capabilities are unchanged.

**Rollout fence:** negotiated reads require shared mode under the existing
transactional mode lock, before any legacy admission, pruning or cadence. Disabled
mode returns `503 feature_disabled` (authentication can return401 first if the
cutover already drained that session). Old **server writers must be drained before
enabling shared mode**: old code could update metrics while retaining an existing
ID. The flag alone cannot make mixed writers safe. Updated servers can stamp old
desktop publishers' unchanged PUT bodies. This contract does not enable mode or
unblock the operator CLI; operational rehearsal/cutover remains separate.

New Wingman receivers always opt in, require exactly one supported format header
and one well-formed matching binding **before parsing JSON, even empty rows**, and
never fall back to legacy. Missing/unsupported/duplicate format is
`protocol_mismatch`; missing/wrong/malformed/duplicate binding is
`malformed_response`. Required-ID DTO validation rejects null/non-v4/noncanonical
IDs, duplicate characters or IDs, extra keys, and invalid existing row fields as a
whole batch. Existing 8192-row and 1MiB success / 64KiB error bounds remain.

This hash is request correlation under trusted HTTPS and a trusted relay, **not a
server signature**. It rejects replayed whole old responses, not a compromised
relay/TLS terminator forging a new binding over old rows. Supported clients journal
the highest **attempted** revision before network, advance it on retry/restart,
retain it on renewal, and obtain a new random session on recovery/pairing. Restoring
a stale journal while reusing its old session is unsupported: restore must recover
or invalidate that session. Stripping unsigned negotiation yields a legacy response
that new receivers reject. Protocol/correlation failures neither rotate keys nor
refresh a remote receipt. Per-publication non-rejuvenating local aging and display
are a separate consumer layer, not permission to reset age on each valid response.

## One shared revision counter and cadence, per session — not per route

`fleet_device_session` carries exactly ONE monotonic `last_revision`
counter and ONE pair of cadence timestamps (`last_publish_at`,
`last_read_at`), never one per request kind. Every signed request —
`PUT /snapshot`, `GET /snapshot`, `GET /catalogue`, and `PUT /session` —
authenticates through the SAME shared gate (`gateSignedSession`,
`fleet-relay.ts`) against that ONE counter and ONE cadence bucket for
its kind (`publish` for the snapshot PUT, `read` shared by both GETs and
the session PUT):

- `revision` must be strictly greater than whatever this session's counter
  last reached, from ANY prior request of ANY kind. A GET's revision is
  consumed exactly like a PUT's; alternating between catalogue and snapshot
  GETs (or a renewal) does not create a separate, independently-replayable
  sequence for each.
- The read cadence bound (a minimum interval since `last_read_at`) is
  likewise shared across `GET /catalogue`, `GET /snapshot`, and
  `PUT /session`: a device cannot dodge it by alternating endpoints.

## The one-in-flight-request contract

**A device must never have more than one fleet-v1 signed request open at a
time (across every route above the pairing line, including a session
renewal).** This is a client-side rule, not something the server can detect
and refuse cleanly — it follows directly from the shared counter above:

Acceptance depends on the order requests are **applied at the server**
(each one, inside its own transaction, checks `revision >
session.last_revision` and then commits), not the order they were **issued
or sent** by the client. A client that always increments `revision`
correctly but sends two requests concurrently — e.g. a catalogue refresh at
revision 5 racing a publish at revision 6 — has no guarantee the lower
revision arrives and commits first. If the higher-revision request commits
first, the lower one is refused as `revision_replayed` even though it was
constructed correctly and sent first: from the server's point of view, a
request carrying a revision no greater than the session's current counter
is indistinguishable from a genuine captured-and-replayed request, by
design (this is the whole point of the counter). The same reasoning applies
to the shared cadence bucket: two concurrent reads can make one look
`rate_limited` for a reason that has nothing to do with the device's real
request rate.

None of this is a security concern (the worst case is a spurious refusal
of an otherwise-legitimate request, never an accepted forgery), but it is a
correctness trap for a client that assumes "one call site issues catalogue
refreshes, another issues publishes, they can run independently." They
cannot: every fleet-v1 signed request for one device must be issued,
awaited, and completed (success OR failure) before the next one is sent,
regardless of which route it targets.

Wingman's own client (`wingman/fleetsharing/client.py`) is a pure,
stateless transport with no queue of its own — the coordinator on the other
side (`wingman/fleetsharing/worker.py`) is what owns this constraint: its
`_iterate()` pass runs catalogue refresh, then publish, then session
renewal (whichever are due) strictly sequentially inside one
`_iteration_lock`-held pass, and only one pass ever runs at a time (`_run`'s
own loop, and `iterate_once`'s explicit refusal to run beside a live worker
thread). See that module's docstring for the enforcement side of this same
contract.

## Refusal codes

`FLEET_RELAY_STATUS_BY_CODE` (`fleet-relay.ts`) is the authoritative
code → HTTP status map. `invalid_session`/`forbidden` collapse every
"no such session" / "expired" / "device revoked" / "not eligible" case into
one generic answer per route (never letting a caller distinguish those by
probing); `revision_replayed` and `rate_limited` are deliberately distinct,
since neither leaks anything about eligibility. `try_again` (503) means
the request collided with a genuine Postgres deadlock or serialization
failure under concurrent contention elsewhere in the system (never this
device's own fault) and should simply be retried with a freshly
constructed, freshly signed request — never the prior attempt's exact
bytes, since a lost-response retry must always carry a strictly higher
revision than whatever was last attempted (`isRetryableRelayError`).
