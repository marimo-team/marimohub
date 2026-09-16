# /// script
# requires-python = ">=3.13"
# dependencies = ["marimo==0.24.2", "websockets>=15,<17"]
# ///
"""Run with `uv run scripts/test-app-source.py`. Uses a real marimo app kernel."""

import asyncio
import json
from importlib.metadata import version
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

import websockets

SERVER_TOKEN = ""
MARKER = "APP_SOURCE_ONLY_4815e903"
NOTEBOOK = """import marimo
app = marimo.App()
@app.cell
def _():
    import marimo as mo
    # APP_SOURCE_ONLY_4815e903
    slider = mo.ui.slider(0, 10, value=1)
    slider
    return mo, slider
@app.cell
def _(mo, slider):
    mo.md(f"APP_VALUE_{slider.value}")
    return
@app.cell
def _():
    raise ValueError("Expected fixture failure")  # APP_SOURCE_ONLY_4815e903
    return
if __name__ == "__main__":
    app.run()
"""


def check_source(text):
    assert MARKER not in text, "Notebook source leaked to an app client"


def request(origin, path, session, body=None):
    req = urllib.request.Request(
        origin + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Content-Type": "application/json",
            "Marimo-Session-Id": session,
            "Marimo-Server-Token": SERVER_TOKEN,
        },
    )
    try:
        response = urllib.request.urlopen(req, timeout=10)
    except urllib.error.HTTPError as error:
        response = error
    text = response.read().decode()
    check_source(text)
    return response.status, text


async def check_kernel(origin):
    global SERVER_TOKEN
    session = str(uuid.uuid4())
    status, bootstrap = request(origin, "/?include-code=true&show-code=true", session)
    assert status == 200, status
    token = re.search(r'<marimo-server-token data-token="([^"]+)"', bootstrap)
    assert token, "Missing server token in app bootstrap"
    SERVER_TOKEN = token[1]
    async with websockets.connect(
        origin.replace("http:", "ws:") + f"/ws?session_id={session}"
    ) as ws:
        received = []

        async def until(needle):
            async with asyncio.timeout(45):
                while not any(needle in message for message in received):
                    message = await ws.recv()
                    if isinstance(message, bytes):
                        message = message.decode()
                    check_source(message)
                    received.append(message)

        await until("APP_VALUE_1")
        await until("marimo-error")
        payloads = "\n".join(received)
        match = re.search(r"object-id='([^']+)'", payloads)
        assert match, "Slider object id missing from rendered output"
        status, body = request(
            origin,
            "/api/kernel/set_ui_element_value",
            session,
            {"objectIds": [match[1]], "values": [7]},
        )
        assert status == 200, (status, body)
        await until("APP_VALUE_7")
        for path in [
            "/api/files/read_code",
            "/api/export/script",
            "/api/export/markdown",
            "/api/export/ipynb",
            "/api/files/list_files",
            "/api/files/file_details",
            "/api/kernel/run",
        ]:
            status, _ = request(origin, path, session, {})
            assert status in (401, 403, 404, 405), (path, status)
        status, _ = request(origin, "/api/files/download?path=notebook.py", session)
        assert status in (401, 403), status
        status, exported = request(
            origin,
            "/api/export/html",
            session,
            {"includeCode": True, "download": False, "files": []},
        )
        assert status == 200, (status, exported[:200])
        assert "APP_VALUE_7" in exported, "HTML export did not include the live output"
        # Drain messages queued during HTTP checks, including error notifications.
        while True:
            try:
                check_source(await asyncio.wait_for(ws.recv(), timeout=0.5))
            except TimeoutError:
                break


def main():
    image = Path(__file__).resolve().parents[1] / "images/marimo-sandbox/Dockerfile"
    expected = re.search(r"ARG MARIMO_VERSION=(\S+)", image.read_text())
    assert expected and version("marimo") == expected[1], (
        "Update this test's marimo dependency with the sandbox image"
    )
    with tempfile.TemporaryDirectory(prefix="marimohub-app-source-") as directory:
        root = Path(directory)
        (root / "notebook.py").write_text(NOTEBOOK)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        origin = f"http://127.0.0.1:{port}"
        with (root / "kernel.log").open("w+") as log:
            process = subprocess.Popen(
                [
                    sys.executable,
                    "-m",
                    "marimo",
                    "--quiet",
                    "run",
                    "notebook.py",
                    "--headless",
                    "--no-token",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(port),
                ],
                cwd=root,
                stdout=log,
                stderr=log,
                env={**os.environ, "MARIMO_SKIP_UPDATE_CHECK": "1"},
            )
            try:
                deadline = time.monotonic() + 30
                while time.monotonic() < deadline:
                    try:
                        if request(origin, "/", "probe")[0] == 200:
                            break
                    except urllib.error.URLError:
                        time.sleep(0.1)
                else:
                    raise AssertionError("App kernel did not start")
                asyncio.run(check_kernel(origin))
            finally:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
    print(
        "App interaction, error output, WebSocket data, source endpoints, and HTML export passed"
    )


if __name__ == "__main__":
    main()
