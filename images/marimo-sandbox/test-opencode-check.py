import json
import os
import signal
import subprocess
import tempfile
import threading
import time
import unittest
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


CHECK = Path(__file__).with_name("check-opencode.sh")


class OpenCodeCheckTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.pid_file = self.root / "pid"
        opencode = self.root / "opencode"
        opencode.write_text(
            '#!/bin/sh\necho "fixture server log"\n'
            'echo $$ > "$OPENCODE_PID_FILE"\nexec sleep 300\n'
        )
        opencode.chmod(0o755)
        self.env = {
            **os.environ,
            "PATH": f"{self.root}{os.pathsep}{os.environ['PATH']}",
            "OPENCODE_PID_FILE": str(self.pid_file),
        }
        self.hang_path = None
        self.health_status = 200
        self.skills = [{"name": "marimo-pair"}]
        self.headers = []
        self.requested = threading.Event()
        self.release = threading.Event()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                deadline = time.monotonic() + 5
                while not owner.pid_file.exists():
                    if time.monotonic() >= deadline:
                        self.send_error(503)
                        return
                    time.sleep(0.01)
                if self.path == owner.hang_path:
                    owner.requested.set()
                    owner.release.wait(20)
                    return
                status = 200
                if self.path == "/skill":
                    owner.headers.append(self.headers.get("x-opencode-directory"))
                    body = owner.skills
                else:
                    status = owner.health_status
                    body = {"healthy": status == 200}
                self.send_response(status)
                self.end_headers()
                self.wfile.write(json.dumps(body).encode())

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()

        def cleanup():
            self.release.set()
            self.server.shutdown()
            self.server.server_close()
            thread.join()

        self.addCleanup(cleanup)

    @contextmanager
    def start_check(self):
        process = subprocess.Popen(
            ["bash", str(CHECK), str(self.server.server_port)],
            env=self.env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        try:
            yield process
        finally:
            # curl and the fixture can outlive bash or keep its output pipes open.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=5)
            finally:
                process.stdout.close()
                process.stderr.close()

    def test_discovers_skill_and_stops_server(self):
        with self.start_check() as process:
            _, stderr = process.communicate(timeout=15)
            with self.assertRaises(ProcessLookupError):
                os.kill(int(self.pid_file.read_text()), 0)
        self.assertEqual(process.returncode, 0, stderr)
        self.assertEqual(self.headers, ["/workspace"])
        self.assertNotIn("fixture server log", stderr)

    def test_missing_skill_fails_with_server_log(self):
        self.skills = []
        with self.start_check() as process:
            _, stderr = process.communicate(timeout=15)
        self.assertNotEqual(process.returncode, 0)
        self.assertIn("fixture server log", stderr)

    def test_server_ignoring_sigterm_is_killed_and_reaped(self):
        opencode = self.root / "opencode"
        opencode.write_text(opencode.read_text().replace(
            "#!/bin/sh\n", "#!/bin/sh\ntrap '' TERM\n"
        ))
        with self.start_check() as process:
            _, stderr = process.communicate(timeout=10)
            with self.assertRaises(ProcessLookupError):
                os.kill(int(self.pid_file.read_text()), 0)
        self.assertEqual(process.returncode, 0, stderr)

    def test_server_exiting_before_healthy_fails_fast_with_log(self):
        (self.root / "opencode").write_text(
            '#!/bin/sh\necho "fixture server log"\necho $$ > "$OPENCODE_PID_FILE"\nexit 3\n'
        )
        self.health_status = 503
        started = time.monotonic()
        with self.start_check() as process:
            _, stderr = process.communicate(timeout=10)
        self.assertLess(time.monotonic() - started, 8)
        self.assertNotEqual(process.returncode, 0)
        self.assertIn("exited with status 3 before becoming healthy", stderr)
        self.assertIn("fixture server log", stderr)

    def test_health_deadline_expiry_reports_live_server(self):
        self.health_status = 503
        self.env["OPENCODE_HEALTH_DEADLINE"] = "2"
        with self.start_check() as process:
            _, stderr = process.communicate(timeout=10)
            with self.assertRaises(ProcessLookupError):
                os.kill(int(self.pid_file.read_text()), 0)
        self.assertNotEqual(process.returncode, 0)
        self.assertIn("not ready within 2s (server alive: yes)", stderr)
        self.assertIn("fixture server log", stderr)

    def test_communication_timeout_kills_and_reaps_check(self):
        self.hang_path = "/global/health"
        with self.assertRaises(subprocess.TimeoutExpired):
            with self.start_check() as process:
                self.assertTrue(self.requested.wait(5))
                process.communicate(timeout=0.1)
        self.assertIsNotNone(process.returncode)
        self.assertTrue(process.stdout.closed)
        self.assertTrue(process.stderr.closed)

    def test_assertion_failure_kills_and_reaps_check(self):
        with self.assertRaisesRegex(AssertionError, "fixture assertion"):
            with self.start_check() as process:
                raise AssertionError("fixture assertion")
        self.assertIsNotNone(process.returncode)
        self.assertTrue(process.stdout.closed)
        self.assertTrue(process.stderr.closed)

    def test_stalled_skill_request_has_deadline(self):
        self.hang_path = "/skill"
        with self.start_check() as process:
            _, stderr = process.communicate(timeout=15)
        self.assertTrue(self.requested.is_set())
        self.assertNotEqual(process.returncode, 0)
        self.assertIn("fixture server log", stderr)
        self.assertIn("timed out", stderr)

    def test_termination_during_stalled_health_preserves_log(self):
        self.hang_path = "/global/health"
        with self.start_check() as process:
            self.assertTrue(self.requested.wait(5))
            process.terminate()
            _, stderr = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 124)
        self.assertIn("fixture server log", stderr)


if __name__ == "__main__":
    unittest.main()
