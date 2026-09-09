"""Bounded Linux installation driver; production worker/client/API, not DPAPI proof.

stdin/stdout are private owner pipes, never diagnostic logs. The only navigation
metadata returned is a validated pairing URL. Keys remain in the private root.
"""

import http.client
import json
import logging
import os
import select
import signal
import socket
import ssl
import sys
import time
from collections import deque
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import Request

os.umask(0o077)
root = Path(os.environ["FLEET_INSTALL_ROOT"]).resolve()
origin = os.environ["FLEET_ORIGIN"]
url = urlsplit(origin)
if (
    url.scheme != "https"
    or url.hostname != "localhost"
    or not url.port
    or origin != f"https://localhost:{url.port}"
):
    raise RuntimeError("invalid fixture origin")
if not root.is_dir() or root.stat().st_mode & 0o077:
    raise RuntimeError("private installation required")
ca = Path(os.environ["SSL_CERT_FILE"])
ca_dir = Path(os.environ["SSL_CERT_DIR"])
if list(ca_dir.iterdir()) or len(ssl.create_default_context().get_ca_certs()) != 1:
    raise RuntimeError("fixture-only trust required")
if ssl.create_default_context().get_ca_certs(binary_form=True) != [
    ssl.PEM_cert_to_DER_cert(ca.read_text())
]:
    raise RuntimeError("wrong trust anchor")
for key in tuple(os.environ):
    if key.lower().endswith("_proxy"):
        del os.environ[key]
denials = []


def deny(kind):
    if len(denials) < 100:
        denials.append(kind)
    raise OSError("fixture egress denied")


def audit(event, args):
    if event == "socket.__new__":
        _, family, kind, protocol = args
        kind &= ~(socket.SOCK_NONBLOCK | socket.SOCK_CLOEXEC)
        if (
            family not in (socket.AF_INET, socket.AF_INET6)
            or kind != socket.SOCK_STREAM
            or protocol not in (0, socket.IPPROTO_TCP)
        ):
            deny("creation")
    elif event == "socket.connect":
        address = args[1]
        if (
            not isinstance(address, tuple)
            or address[0] not in ("127.0.0.1", "::1")
            or address[1] != url.port
        ):
            deny("connect")
    elif event == "socket.getaddrinfo":
        host, port, family, kind, protocol = args
        if (
            host not in ("localhost", "127.0.0.1", "::1")
            or port != url.port
            or family not in (socket.AF_UNSPEC, socket.AF_INET, socket.AF_INET6)
            or kind not in (0, socket.SOCK_STREAM)
            or protocol not in (0, socket.IPPROTO_TCP)
        ):
            deny("resolver")
    elif event.startswith("socket."):
        # CPython emits distinct events for legacy resolvers and sendto/sendmsg;
        # they need neither connect nor getaddrinfo. This is a closed network
        # boundary for this stdlib driver, not an arbitrary-code sandbox.
        deny("unsupported")


sys.addaudithook(audit)
# Nothing from Wingman (including its import-time urllib opener) precedes guards.
sys.path.insert(0, os.environ["E2E_WINGMAN_ROOT"])
from wingman.fleetsharing import state as state_module
from wingman.fleetsharing.client import FleetRelayClient, _default_transport
from wingman.fleetsharing.worker import FleetSharingWorker

# Closed bootstrap regressions; never accept a general URL/HTTP executor.
probe = os.environ.get("FLEET_PROBE")
if probe:
    if probe == "legacy-recovery":
        import secrets
        from dataclasses import replace
        from datetime import UTC, datetime

        from wingman.fleetsharing import crypto

        private_key = (root / "legacy-key.bin").read_bytes()
        identity = state_module.DeviceIdentity(
            state_module.wrap_private_key(private_key, protect=lambda raw: raw),
            crypto.canonical_device_public_key_b64(crypto.public_key_spki(private_key)),
        )
        pending_recovery = state_module.PendingRecovery(
            secrets.token_urlsafe(32),
            datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        )
        saved = state_module.SharingState(
            identity=identity, relay_origin=origin, pending_recovery=pending_recovery
        )
        state_module.save(root / "fleet.json", saved)
        client = FleetRelayClient(origin)
        first = client.begin_recovery(
            private_key=private_key,
            request_id=pending_recovery.request_id,
            issued_at=pending_recovery.issued_at,
        )
        state_module.save(
            root / "fleet.json",
            replace(saved, pending_recovery=replace(pending_recovery, challenge=first)),
        )
        retry = client.begin_recovery(
            private_key=private_key,
            request_id=pending_recovery.request_id,
            issued_at=pending_recovery.issued_at,
        )
        assert retry == first
        result = client.complete_recovery(private_key=private_key, challenge=first)
        print(
            json.dumps(
                {
                    "idempotent": True,
                    "result": result.result,
                    "fresh_key_required": result.requires_fresh_key_setup,
                }
            ),
            flush=True,
        )
    elif probe == "signed-redirect":
        from datetime import UTC, datetime

        from wingman.fleetsharing import crypto
        from wingman.fleetsharing.client import FleetRelayError

        try:
            FleetRelayClient(origin).read_snapshot(
                session_id="00000000-0000-4000-8000-000000000001",
                private_key=crypto.generate_private_key(),
                revision=1,
                now=datetime.now(UTC),
            )
            raise AssertionError("signed redirect accepted")
        except FleetRelayError as error:
            assert error.status == 307
            print(
                json.dumps({"redirect": "refused", "denials": len(denials)}), flush=True
            )
    elif probe == "egress":

        def datagram(family, address):
            with socket.socket(family, socket.SOCK_DGRAM) as sock:
                sock.sendto(b"negative-control", address)

        def create_forbidden(family, kind, protocol=0):
            with socket.socket(family, kind, protocol):
                pass

        with socket.socket() as denied_socket:
            attempts = (
                lambda: denied_socket.connect(("127.0.0.1", url.port + 1)),
                lambda: socket.getaddrinfo("127.0.0.1", url.port + 1),
                lambda: datagram(socket.AF_INET, ("127.0.0.1", url.port + 1)),
                lambda: datagram(socket.AF_INET6, ("::1", url.port + 1)),
                lambda: create_forbidden(
                    socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP
                ),
                lambda: create_forbidden(socket.AF_UNIX, socket.SOCK_STREAM),
                lambda: denied_socket.sendto(
                    b"negative-control", ("127.0.0.1", url.port + 1)
                ),
                lambda: denied_socket.sendmsg(
                    [b"negative-control"], [], 0, ("127.0.0.1", url.port + 1)
                ),
                lambda: socket.gethostbyname("127.0.0.1"),
                lambda: socket.gethostbyname_ex("127.0.0.1"),
                lambda: socket.gethostbyaddr("127.0.0.1"),
                lambda: socket.getnameinfo(
                    ("127.0.0.1", url.port + 1),
                    socket.NI_NUMERICHOST | socket.NI_NUMERICSERV,
                ),
                lambda: socket.getaddrinfo(
                    "127.0.0.1", url.port, socket.AF_INET, socket.SOCK_DGRAM
                ),
                lambda: denied_socket.bind(("127.0.0.1", 0)),
            )
            escaped = 0
            for attempt in attempts:
                before = len(denials)
                try:
                    attempt()
                except OSError:
                    pass
                escaped += len(denials) != before + 1
        print(json.dumps({"denials": len(denials), "escaped": escaped}), flush=True)
    elif probe in ("trusted", "untrusted", "wrong-host"):
        target = (
            origin.replace("localhost", "127.0.0.1")
            if probe == "wrong-host"
            else origin
        )
        try:
            with _default_transport(Request(target), timeout=2) as result:
                assert probe == "trusted" and result.status == 200
                print(json.dumps({"tls": "verified"}), flush=True)
        except URLError as error:
            assert probe != "trusted" and isinstance(
                error.reason, ssl.SSLCertVerificationError
            )
            print(
                json.dumps(
                    {"tls": "certificate_rejected", "reason": error.reason.verify_code}
                ),
                flush=True,
            )
    else:
        raise ValueError("invalid probe")
    sys.exit(0)
from tests.test_api import FakeWindow, make_api, pushes
from wingman import paths, settings
from wingman.telemetry.model import FleetRow, FleetSnapshot, StreamHealth

logging.disable(logging.CRITICAL)
state_path = root / "fleet.json"
preference_path = root / "preference.json"
enabled = json.loads(preference_path.read_text()) if preference_path.exists() else False


class OwnedWindow(FakeWindow):
    """Only native delivery is fake; keep bounded last-payload observations."""

    def __init__(self):
        super().__init__()
        self.deliveries = 0

    def evaluate_js(self, script):
        self.evaluated = [script]
        self.deliveries += 1


api = make_api(root, window=OwnedWindow())
api._fleetbar_window = OwnedWindow()
local_names = (
    ("Task10 Boss", "Task10 Boss Alt", "Task10 Outside A")
    if os.environ["FLEET_INSTALL_SLOT"] == "a"
    else ("Task10 Quiet", "Task10 Included Alt", "Task10 Outside B")
)
api._state.settings["fleet_bar"] = settings.validated_fleet_bar({"enabled": True})
api._install_fleet_generation(1)
worker = FleetSharingWorker(
    load_state=lambda: state_module.load(state_path),
    save_state=lambda value: state_module.save(state_path, value),
    sharing_enabled=lambda: enabled,
    # Test-only Linux protection seam. No claim of at-rest DPAPI validation.
    wrap_private_key=lambda value: state_module.wrap_private_key(
        value, protect=lambda raw: raw
    ),
    unwrap_private_key=lambda value: state_module.unwrap_private_key(
        value, unprotect=lambda raw: raw
    ),
)
assert worker._client_factory is FleetRelayClient
assert FleetRelayClient(origin)._transport is _default_transport
details = set()
same_publication = 0
new_publication = 0
age_violations = 0
remote_deliveries = 0


def receive_remote(event):
    global same_publication, new_publication, age_violations, remote_deliveries
    previous = dict(api._remote_fleet._timing)
    api._receive_remote_fleet_snapshot(event)
    if event.kind == "replace":
        remote_deliveries += 1
        for row in event.rows:
            before = previous.get(row.publication_id)
            after = api._remote_fleet._timing.get(row.publication_id)
            if before and after:
                same_publication += 1
                age_violations += int(after.origin > before.origin)
            elif after:
                new_publication += 1


subscriptions = [
    worker.subscribe_remote(receive_remote),
    worker.subscribe_catalogue(api._receive_fleet_catalogue),
    worker.subscribe_status(
        lambda current: details.add(current.detail) if current.detail else None
    ),
]
requests = deque(maxlen=1000)
sessions = {}
original_request = http.client.HTTPConnection.request
original_response = http.client.HTTPConnection.getresponse
original_read = http.client.HTTPResponse.read
original_completed = worker._scheduler.completed
pending = {}


def request(self, method, path, body=None, headers=None, *, encode_chunked=False):
    normalized = {k.lower(): v for k, v in (headers or {}).items()}
    session = normalized.get("x-fleet-session")
    revision = normalized.get("x-fleet-revision")
    if revision is not None:
        durable = state_module.load(state_path)
        assert durable.session_id == session and durable.last_revision == int(
            revision
        ), "revision was not durable before send"
        sessions.setdefault(session, len(sessions) + 1)
    operation = path.rsplit("/", 1)[-1]
    if "pairing-requests/" in path:
        operation = "pairing-complete"
    elif "recovery-challenges/" in path:
        operation = "recovery-complete"
    event = {
        "operation": operation,
        "method": method,
        "revision": int(revision) if revision else None,
        "session": sessions.get(session),
        "start": time.monotonic(),
        "headers_received": None,
        "body_received": None,
        "completed": None,
        "failed": None,
        "status": None,
    }
    requests.append(event)
    pending[id(self)] = event
    return original_request(
        self, method, path, body, headers or {}, encode_chunked=encode_chunked
    )


def response(self):
    result = original_response(self)
    event = pending.pop(id(self), None)
    if event is not None:
        event.update(headers_received=time.monotonic(), status=result.status)
        result._fleet_event = event
    return result


def read_response(self, *args, **kwargs):
    result = original_read(self, *args, **kwargs)
    event = getattr(self, "_fleet_event", None)
    if event is not None and self.isclosed():
        event["body_received"] = time.monotonic()
    return result


def completed(work, now, *, failed=False, jitter=0):
    # Observe the exact timestamp passed by the real worker after acceptance or
    # failure. Never substitute headers for completion, or change admission.
    if requests and requests[-1]["completed"] is None:
        requests[-1].update(completed=now, failed=failed)
    pending.clear()
    return original_completed(work, now, failed=failed, jitter=jitter)


http.client.HTTPConnection.request = request
http.client.HTTPConnection.getresponse = response
http.client.HTTPResponse.read = read_response
worker._scheduler.completed = completed

snapshot = None
stopping = False


def stop_signal(_signum, _frame):
    global stopping
    stopping = True


signal.signal(signal.SIGTERM, stop_signal)
signal.signal(signal.SIGINT, stop_signal)


def status():
    current = worker.status()
    saved = state_module.load(state_path)
    payload = api.fleet_bar_snapshot()
    settings_payload = api.fleet_bar_settings()
    persisted = settings.load(paths.settings_file())["fleet_bar"]
    with api._fleet_presentation_lock:
        pending_roster = list(api._fleet_roster.pending)
    presented = dict(pushes(api._window)).get("onFleetBarState", {})
    known = (
        settings_payload["seen"]
        + [row["name"] for row in settings_payload["characters"]]
        + persisted["seen"]
        + pending_roster
        + [row["name"] for row in presented.get("characters", [])]
    )
    return {
        "state": current.state,
        "detail": current.detail,
        "pairing": current.pairing,
        "paired": bool(saved.session_id),
        "revision": saved.last_revision,
        "participation": current.participation,
        "inhibited": current.local_inhibited,
        "observed_on": bool(
            current.observed_participation and current.observed_participation.enabled
        ),
        "eligible": len(current.eligibility.characters) if current.eligibility else 0,
        "sources": [
            {"state": item.state, "reason": item.reason}
            for item in current.sources.sources
        ]
        if current.sources
        else [],
        "pending_sources": len(saved.pending_source_commands),
        "source_choices": sum(c.has_fleet_read for c in current.sources.characters)
        if current.sources
        else 0,
        "remote": [
            {"dps": r["dps"], "state": r["state"], "ewar": r["ewar"]}
            for r in payload["rows"]
            if r.get("remote")
        ],
        "local": sum(not r.get("remote", False) for r in payload["rows"]),
        "seen": len(settings_payload["seen"]),
        "settings_characters": len(settings_payload["characters"]),
        "persisted_seen": len(persisted["seen"]),
        "pending_roster": len(pending_roster),
        "unexpected_settings": sum(name not in local_names for name in known),
        "presented_characters": len(presented.get("characters", [])),
        "fleet_presentations": api._fleetbar_window.deliveries,
        "denials": len(denials),
        "requests": list(requests),
        "details": sorted(details),
        "same_publication": same_publication,
        "new_publication": new_publication,
        "age_violations": age_violations,
        "remote_deliveries": remote_deliveries,
    }


def command(data):
    global enabled, snapshot, stopping
    if not isinstance(data, dict) or set(data) != {"command"}:
        raise ValueError("invalid command")
    cmd = data["command"]
    if cmd == "pair":
        assert worker.request_pairing(configured_origin=origin)
    elif cmd == "approval":
        return {"approval_url": worker.status().approval_url}
    elif cmd in ("on", "off"):
        enabled = cmd == "on"
        preference_path.write_text(json.dumps(enabled))
        assert worker.request_participation(enabled)
    elif cmd in ("watch", "unwatch"):
        assert worker.set_source_watch(cmd == "watch")
    elif cmd in ("start-first", "start-second", "start-third"):
        sources = worker.status().sources
        choices = [c for c in sources.characters if c.has_fleet_read] if sources else []
        index = ("start-first", "start-second", "start-third").index(cmd)
        if len(choices) <= index:
            raise ValueError("source choice unavailable")
        ch = choices[index]
        assert worker.request_source_start(ch.character_id, ch.character_link_epoch)
    elif cmd == "stop-sources":
        sources = worker.status().sources
        for source in sources.sources if sources else ():
            if source.state != "ended":
                assert worker.request_source_stop(
                    source.source_id, expected_generation=source.generation
                )
    elif cmd in ("local", "quiet"):
        snapshot = FleetSnapshot(
            tuple(
                FleetRow(name, 42 + i, ("SCRAM", "POINT") if i == 1 else ())
                for i, name in enumerate(local_names)
            )
            if cmd == "local"
            else (),
            StreamHealth("active"),
            activation_generation=1,
        )
        api._receive_fleet_snapshot(snapshot)
        worker.submit(snapshot)
    elif cmd == "stop":
        stopping = True
    elif cmd != "status":
        raise ValueError("unknown command")
    return status()


next_snapshot = time.monotonic()
try:
    assert api._start_fleet_presentation()
    worker.start()
    print(json.dumps({"ready": True, "trust_anchors": 1}), flush=True)
    while not stopping:
        ready, _, _ = select.select([sys.stdin], [], [], 0.05)
        if ready:
            line = sys.stdin.readline(4097)
            if not line:
                break
            if len(line) > 4096:
                raise ValueError("oversized command")
            try:
                result = command(json.loads(line))
                print(json.dumps({"ok": True, "value": result}), flush=True)
            except (ValueError, AssertionError):
                print(
                    json.dumps({"ok": False, "error": "invalid_command_or_invariant"}),
                    flush=True,
                )
        now = time.monotonic()
        if snapshot is not None and now >= next_snapshot:
            worker.submit(snapshot)
            next_snapshot = now + 0.5
finally:
    for unsubscribe in subscriptions:
        unsubscribe()
    stopped = worker.stop(6)
    presentation_stopped = api._stop_fleet_presentation(2)
    if not stopped or not presentation_stopped or denials:
        sys.exit(1)
