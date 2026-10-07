import json
import os
from pathlib import Path
import socket
import subprocess
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
        self.sessions = {"session-1": {"path": "notebook.py"}}
        self.sessions_status = 200
        self.code = "print(42)"
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
        self.env = {
            **os.environ,
            "MARIMOHUB_KERNEL_URL": self.origin + self.base_path + "/",
            "MARIMOHUB_KERNEL_TOKEN_FILE": str(self.token_file),
            "MARIMO_TOKEN": "",
            "XDG_STATE_HOME": str(root / "surface-state"),
        }

    def run_script(self, name, *args, success=True, stdin=None):
        result = subprocess.run(
            ["bash", str(SKILL / "scripts" / name), *args],
            env=self.env, text=True, capture_output=True, timeout=10, input=stdin,
        )
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("test-kernel-secret", result.stdout + result.stderr)
        return result

    def execute(self, *args, success=True):
        self.requests.clear()
        return self.run_script("execute-code.sh", *args, "-c", self.code, success=success)

    def assert_requests(self, *paths):
        self.assertEqual([path for path, _ in self.requests],
                         [self.base_path + path for path in paths])

    def test_authenticated_kernel_with_empty_registry(self):
        discovered = json.loads(self.run_script("discover-servers.sh").stdout)
        self.assertEqual(discovered[0]["url"], self.env["MARIMOHUB_KERNEL_URL"])
        self.assert_requests()
        result = self.execute()
        self.assertEqual(result.stdout, "42\n")
        self.assert_requests("/api/sessions", "/api/kernel/execute")
        self.assertTrue(all(auth == self.expected_token for _, auth in self.requests))

    def test_auth_off_with_surface_state_directory(self):
        self.expected_token = None
        self.env["MARIMOHUB_KERNEL_TOKEN_FILE"] = ""
        self.base_path = ""
        self.env["MARIMOHUB_KERNEL_URL"] = self.origin + "/"
        self.assertEqual(self.execute().stdout, "42\n")

    def test_explicit_discovered_url_uses_token_file(self):
        self.execute("--url", self.env["MARIMOHUB_KERNEL_URL"].rstrip("/"),
                     "--file", "notebook.py")

    def test_explicit_other_url_does_not_receive_hub_token(self):
        self.env["MARIMOHUB_KERNEL_URL"] = "http://127.0.0.1:1/proxy/other/"
        self.expected_token = None
        self.execute("--url", self.origin + self.base_path)

    def test_explicit_token_overrides_file(self):
        self.expected_token = "Bearer explicit-token"
        self.token_file.unlink()
        self.execute("--token", "explicit-token")

    def test_environment_token_overrides_missing_file(self):
        self.token_file.unlink()
        self.env["MARIMO_TOKEN"] = "environment-token"
        self.expected_token = "Bearer environment-token"
        self.execute()

    def test_other_url_does_not_require_hub_token_file(self):
        self.token_file.unlink()
        self.expected_token = None
        self.env["MARIMOHUB_KERNEL_URL"] = self.origin + "/proxy/another-kernel/"
        self.execute("--url", self.origin + self.base_path)

    def test_last_url_option_controls_credential_selection(self):
        other = self.origin + "/proxy/another-kernel/"
        for urls, expected in [
            ([other, self.env["MARIMOHUB_KERNEL_URL"]], "Bearer test-kernel-secret"),
            ([self.env["MARIMOHUB_KERNEL_URL"], other], None),
        ]:
            with self.subTest(urls=urls):
                self.expected_token = expected
                self.base_path = "/proxy/another-kernel" if expected is None else "/proxy/routing-token"
                self.execute("--url", urls[0], "--url", urls[1])
                self.assert_requests("/api/sessions", "/api/kernel/execute")

    def test_code_arguments_are_not_parsed_as_connection_options(self):
        self.code = 'print("--url http://other.example --token ignored")'
        self.execute()

    def test_code_from_stdin_and_a_file_with_spaces(self):
        for args in [(), ("-",)]:
            with self.subTest(args=args):
                self.assertEqual(self.run_script("execute-code.sh", *args,
                                                stdin=self.code).stdout, "42\n")
        code_file = Path(self.directory.name) / "code with spaces.py"
        code_file.write_text(self.code)
        self.assertEqual(self.run_script("execute-code.sh", str(code_file)).stdout, "42\n")

    def test_incomplete_options_fail_without_contacting_kernel(self):
        for option in ("--url", "--token", "--file", "--session", "-c"):
            with self.subTest(option=option):
                self.run_script("execute-code.sh", option, success=False)
        self.assert_requests()

    def test_missing_token_file_fails_before_network(self):
        self.token_file.unlink()
        self.execute(success=False)
        self.assert_requests()

    def test_token_path_is_a_directory(self):
        self.token_file.unlink()
        self.token_file.mkdir()
        self.execute(success=False)
        self.assert_requests()

    def test_invalid_or_empty_token_fails_without_executing_code(self):
        for token in ("wrong-token", ""):
            with self.subTest(token=token):
                self.token_file.write_text(token)
                self.execute(success=False)
                self.assert_requests("/api/sessions")

    def test_unreachable_kernel_fails(self):
        with socket.socket() as unavailable:
            unavailable.bind(("127.0.0.1", 0))
            self.env["MARIMOHUB_KERNEL_URL"] = f"http://127.0.0.1:{unavailable.getsockname()[1]}/"
            self.execute(success=False)
        self.assert_requests()

    def test_missing_or_malformed_url_fails_without_network(self):
        for url in ("", "http://["):
            with self.subTest(url=url):
                self.env["MARIMOHUB_KERNEL_URL"] = url
                self.execute(success=False)
                self.assert_requests()

    def test_stale_explicit_session_is_not_retried(self):
        self.execute("--session", "stale-session", success=False)
        self.assert_requests("/api/kernel/execute")

    def test_http_errors_fail_without_retrying_or_executing(self):
        for status in (401, 404, 503):
            with self.subTest(status=status):
                self.sessions_status = status
                self.execute(success=False)
                self.assert_requests("/api/sessions")

    def test_missing_or_ambiguous_sessions_do_not_execute(self):
        for sessions in ({}, {**self.sessions, "session-2": {"path": "another.py"}}):
            with self.subTest(sessions=sessions):
                self.sessions = sessions
                self.execute(success=False)
                self.assert_requests("/api/sessions")

    def test_failed_or_interrupted_execution_is_not_replayed(self):
        for execution in (
            b'event: stderr\ndata: {"data":"execution failed"}\n\nevent: done\ndata: {"success":false}\n\n',
            b'event: stdout\ndata: {"data":"partial output"}\n\n',
        ):
            with self.subTest(execution=execution):
                self.execution = execution
                self.execute(success=False)
                self.assert_requests("/api/sessions", "/api/kernel/execute")

    def test_non_hub_execution_keeps_upstream_behavior(self):
        self.env.pop("MARIMOHUB_KERNEL_URL")
        self.env.pop("MARIMOHUB_KERNEL_TOKEN_FILE")
        self.env["MARIMO_TOKEN"] = "test-kernel-secret"
        self.execute("--url", self.origin + self.base_path)
        self.assertEqual(json.loads(self.run_script("discover-servers.sh").stdout), [])


if __name__ == "__main__":
    unittest.main()
