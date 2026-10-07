import base64
import importlib.resources
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


assert os.getuid() != 0, "Bridge reinstall must run as the sandbox user"

source = Path("/tmp/notebook-bridge.ts").read_text()
name = re.search(r"export const WHEEL_NAME =\s*'([^']+)';", source)[1]
payload = re.search(r"export const WHEEL_BASE64 =\s*'([^']+)';", source)[1]
identity = re.search(r"export const ARTIFACT_ID =\s*'([^']+)';", source)[1]

with tempfile.TemporaryDirectory() as directory:
    wheel = Path(directory) / name
    wheel.write_bytes(base64.b64decode(payload, validate=True))
    # Force the upgrade path even when the image and hub bridge identities match.
    subprocess.run(
        ["uv", "pip", "install", "--python", sys.executable,
         "--no-deps", "--no-index", "--reinstall-package", "marimohub-notebook-bridge",
         str(wheel)],
        check=True,
    )

actual = importlib.resources.files("marimohub_notebook_bridge").joinpath("identity").read_text()
assert actual == identity, f"Bridge identity mismatch: {actual} != {identity}"

cache = Path(os.environ["UV_CACHE_DIR"])
for path in [cache, *cache.rglob("*")]:
    assert path.lstat().st_uid == os.getuid(), f"Cache entry is not owned by the sandbox user: {path}"

print("Bridge reinstall and uv cache ownership passed")
