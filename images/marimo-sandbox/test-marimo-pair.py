import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


SKILL = Path(os.environ.get("MARIMO_PAIR_SKILL", "/home/appuser/.agents/skills/marimo-pair"))


class PairConnectionTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.token_file = root / "kernel token"
        self.token_file.write_text("test-kernel-secret\n")
        self.requests = []
        self.expected_token = "Bearer test-kernel-secret"
        self.base_path = "/proxy/routing-token"
        self.sessions = {"session-1": {"filename": "notebook.py", "path": "notebook.py"}}
        self.sessions_status = 200
        self.code = "import marimo._code_mode as cm; help(cm)"
        self.execution = (b'event: stdout\ndata: {"data":"42\\n"}\n\n'
                          b'event: done\ndata: {"success":true}\n\n')
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                owner.requests.append((self.path, self.headers.get("Authorization")))
                if self.path != owner.base_path + "/api/sessions":
                    self.send_error(404)
                    return
                if self.headers.get("Authorization") != owner.expected_token:
                    self.send_error(401)
                    return
                self.send_response(owner.sessions_status)
                self.end_headers()
                self.wfile.write(json.dumps(owner.sessions).encode())

            def do_POST(self):
                owner.requests.append((self.path, self.headers.get("Authorization")))
                if (self.path != owner.base_path + "/api/kernel/execute"
                        or self.headers.get("Authorization") != owner.expected_token
                        or self.headers.get("Marimo-Session-Id") != "session-1"):
                    self.send_error(403)
                    return
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if payload["code"] != owner.code:
                    self.send_error(400)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                self.wfile.write(owner.execution)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def stop():
            server.shutdown()
            server.server_close()
            thread.join()

        self.addCleanup(stop)
        self.origin = f"http://127.0.0.1:{server.server_port}"
        # /workspace usually has no pyproject, so uv runs in no-project mode via VIRTUAL_ENV.
        self.cwd = root / "workspace"
        self.cwd.mkdir()
        self.project_cwd = root / "project"
        self.project_cwd.mkdir()
        self.project_cwd.joinpath("pyproject.toml").write_text(
            '[project]\nname = "pair-test"\nversion = "0.0.0"\n')
        self.command = SKILL.joinpath("SKILL.md").read_text().split("```bash\n", 1)[1].split("```", 1)[0]
        self.env = {
            **os.environ,
            "MARIMOHUB_KERNEL_URL": self.origin + self.base_path + "/",
            "MARIMOHUB_KERNEL_TOKEN_FILE": str(self.token_file),
            "MARIMO_TOKEN": "",
            "UV_PROJECT_ENVIRONMENT": sys.prefix,
            "XDG_STATE_HOME": str(root / "surface-state"),
        }

    def run_pair(self, *, listing=False, success=True):
        self.requests.clear()
        command = self.command
        if listing:
            setup = command.split("uv run --no-sync marimo pair execute", 1)[0]
            command = setup + 'uv run --no-sync marimo pair notebook list "${kernel_args[@]}"'
        result = subprocess.run(
            ["bash", "-c", command], cwd=self.cwd,
            env=self.env, text=True, capture_output=True, timeout=15,
        )
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("test-kernel-secret", result.stdout + result.stderr)
        return result

    def assert_requests(self, *paths):
        self.assertEqual([path for path, _ in self.requests],
                         [self.base_path + path for path in paths])

    def test_skill_commands_connect_without_a_server_registry(self):
        bare_cwd = self.cwd
        for project in (False, True):
            for auth in (False, True):
                for base_path in ("", "/proxy/routing-token"):
                    with self.subTest(project=project, auth=auth, base_path=base_path):
                        self.cwd = self.project_cwd if project else bare_cwd
                        self.base_path = base_path
                        self.expected_token = "Bearer test-kernel-secret" if auth else None
                        self.env["MARIMOHUB_KERNEL_URL"] = self.origin + base_path + "/"
                        self.env["MARIMOHUB_KERNEL_TOKEN_FILE"] = str(self.token_file) if auth else ""
                        listing = json.loads(self.run_pair(listing=True).stdout)
                        self.assertEqual(listing["warnings"], [])
                        self.assertEqual(listing["notebooks"][0]["sessions"], [{"id": "session-1"}])
                        self.assert_requests("/api/sessions")
                        executed = json.loads(self.run_pair().stdout)
                        self.assertTrue(executed["success"])
                        self.assertEqual(executed["stdout"], "42\n")
                        self.assert_requests("/api/sessions", "/api/kernel/execute")
                        self.assertTrue(all(auth == self.expected_token for _, auth in self.requests))

    def test_missing_token_file_fails_before_network(self):
        self.token_file.unlink()
        for listing in (False, True):
            with self.subTest(listing=listing):
                self.run_pair(listing=listing, success=False)
                self.assert_requests()

    def test_rejected_token_does_not_execute(self):
        self.token_file.write_text("wrong-token")
        self.run_pair(success=False)
        self.assert_requests("/api/sessions")

    def test_unreachable_kernel_fails(self):
        with socket.socket() as unavailable:
            unavailable.bind(("127.0.0.1", 0))
            self.env["MARIMOHUB_KERNEL_URL"] = f"http://127.0.0.1:{unavailable.getsockname()[1]}/"
            self.run_pair(success=False)
        self.assert_requests()

    def test_missing_or_ambiguous_sessions_do_not_execute(self):
        for sessions in ({}, {**self.sessions, "session-2": {"filename": "another.py", "path": "another.py"}}):
            with self.subTest(sessions=sessions):
                self.sessions = sessions
                self.run_pair(success=False)
                self.assert_requests("/api/sessions")

    def test_http_errors_do_not_execute(self):
        for status in (404, 503):
            with self.subTest(status=status):
                self.sessions_status = status
                self.run_pair(success=False)
                self.assert_requests("/api/sessions")

    def test_interrupted_execution_is_not_replayed(self):
        self.execution = b'event: stdout\ndata: {"data":"partial output"}\n\n'
        self.run_pair(success=False)
        self.assert_requests("/api/sessions", "/api/kernel/execute")


if __name__ == "__main__":
    unittest.main()
