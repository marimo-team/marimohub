import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


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
                if self.path == "/skill":
                    owner.headers.append(self.headers.get("x-opencode-directory"))
                    body = owner.skills
                else:
                    body = {"healthy": True}
                self.send_response(200)
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
            if self.pid_file.exists():
                try:
                    os.kill(int(self.pid_file.read_text()), signal.SIGKILL)
                except ProcessLookupError:
                    pass

        self.addCleanup(cleanup)

    def start_check(self):
        return subprocess.Popen(
            ["bash", str(CHECK), str(self.server.server_port)],
            env=self.env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

    def test_discovers_skill_and_stops_server(self):
        with self.start_check() as process:
            _, stderr = process.communicate(timeout=15)
        self.assertEqual(process.returncode, 0, stderr)
        self.assertEqual(self.headers, ["/workspace"])
        self.assertNotIn("fixture server log", stderr)
        with self.assertRaises(ProcessLookupError):
            os.kill(int(self.pid_file.read_text()), 0)

    def test_missing_skill_fails_with_server_log(self):
        self.skills = []
        with self.start_check() as process:
            _, stderr = process.communicate(timeout=15)
        self.assertNotEqual(process.returncode, 0)
        self.assertIn("fixture server log", stderr)

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
