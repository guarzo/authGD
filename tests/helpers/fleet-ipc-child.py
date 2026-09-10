#!/usr/bin/python3
"""Adversarial pipe peer only; never imported by the real installation driver."""

import json
import os
import sys
import time
from pathlib import Path

root = Path(os.environ["FLEET_INSTALL_ROOT"])
(root / "fixture-pid").write_text(str(os.getpid()))
if os.environ.get("FLEET_PROBE") == "legacy-recovery":
    mode = (root / "legacy-key.bin").read_bytes()[0]
    sys.stdout.buffer.write(b"x" * 513 + (b"\n" if mode else b""))
    sys.stdout.flush()
    time.sleep(20)
else:
    print(json.dumps({"ready": True, "trust_anchors": 1}), flush=True)
    for count, line in enumerate(sys.stdin, 1):
        (root / "fixture-count").write_text(str(count))
        mode = (root / "fixture-mode").read_text()
        if mode.startswith("overflow"):
            chunk = "é".encode() if "utf8" in mode else b"x"
            sys.stdout.buffer.write(chunk * (300_000 if "utf8" in mode else 524_289))
            if "newline" in mode:
                sys.stdout.buffer.write(b"\n")
            sys.stdout.flush()
            time.sleep(20)
        else:
            time.sleep(0.15)
            print(json.dumps({"ok": True, "value": {"count": count}}), flush=True)
