import base64
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


source = Path(sys.argv[1]).read_text()
name = re.search(r"export const WHEEL_NAME =\s*'([^']+)';", source)[1]
payload = re.search(r"export const WHEEL_BASE64 =\s*'([^']+)';", source)[1]
with tempfile.TemporaryDirectory() as directory:
    wheel = Path(directory) / name
    wheel.write_bytes(base64.b64decode(payload, validate=True))
    subprocess.run(
        ["uv", "pip", "install", "--python", os.environ["UV_PROJECT_ENVIRONMENT"],
         "--no-deps", "--no-index", "--compile-bytecode", str(wheel)],
        check=True,
    )
