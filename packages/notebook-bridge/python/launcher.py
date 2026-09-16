import importlib
import importlib.resources
import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def install():
    import fcntl

    root = Path(__file__).resolve().parent
    config = json.loads((root / "install.json").read_text())
    timeout = min(10.0, max(0.0, float(os.environ.get("MARIMOHUB_BRIDGE_INSTALL_TIMEOUT_MS", "10000")) / 1000))
    startup_deadline = os.environ.get("MARIMOHUB_BRIDGE_STARTUP_DEADLINE_MS")
    if startup_deadline:
        timeout = min(timeout, float(startup_deadline) / 1000 - time.time())
    deadline = time.monotonic() + timeout

    def remaining():
        value = deadline - time.monotonic()
        if value <= 0:
            raise TimeoutError("Bridge installation deadline exceeded")
        return value

    # Local uv launches can share a cached environment across sandboxes.
    with (Path(sys.prefix) / ".marimohub-notebook-bridge.lock").open("a") as lock:
        while True:
            remaining()
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                time.sleep(min(0.05, remaining()))
        try:
            current = importlib.resources.files("marimohub_notebook_bridge").joinpath("identity").read_text()
            if current == config["identity"]:
                return
        except (ImportError, FileNotFoundError):
            pass
        subprocess.run(
            ["uv", "pip", "install", "--python", sys.executable, "--no-deps", "--no-index",
             "--reinstall-package", "marimohub-notebook-bridge", str(root / config["wheel"])],
            check=True, capture_output=True, timeout=remaining(),
        )
        sys.modules.pop("marimohub_notebook_bridge", None)
        importlib.invalidate_caches()


def main():
    try:
        install()
    except Exception:
        os.environ.pop("MARIMOHUB_BRIDGE_PARENT_ORIGIN", None)
        print('{"event":"notebook_bridge_unavailable","reason":"install_failed"}', file=sys.stderr)
    entry = next(
        entry for entry in importlib.metadata.distribution("marimo").entry_points
        if entry.group == "console_scripts" and entry.name == "marimo"
    )
    sys.argv[0] = "marimo"
    entry.load()()


if __name__ == "__main__":
    main()
