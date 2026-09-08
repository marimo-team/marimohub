import base64
import importlib.util
import json
import os
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request

try:
    from agent.fargate_agent import AgentServer, AgentState
except ModuleNotFoundError:
    _spec = importlib.util.spec_from_file_location(
        "fargate_agent", os.path.join(os.path.dirname(__file__), "fargate_agent.py")
    )
    if _spec is None or _spec.loader is None:
        raise
    _module = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_module)
    AgentServer = _module.AgentServer
    AgentState = _module.AgentState


TOKEN = "t" * 64


class AgentTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.state = AgentState(TOKEN)
        cls.server = AgentServer(("127.0.0.1", 0), cls.state)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def request(self, method, path, payload=None, token=TOKEN):
        body = None if payload is None else json.dumps(payload).encode()
        headers = {"Authorization": f"Bearer {token}"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base + path, data=body, headers=headers, method=method)
        with urllib.request.urlopen(request, timeout=5) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None

    def test_health_requires_auth_and_reports_protocol(self):
        status, body = self.request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(body["protocolVersion"], 1)
        request = urllib.request.Request(self.base + "/health", method="GET")
        with self.assertRaises(urllib.error.HTTPError) as failure:
            urllib.request.urlopen(request, timeout=5)
        self.assertEqual(failure.exception.code, 401)

    def test_exec_binary_and_timeout(self):
        status, body = self.request("POST", "/exec", {"command": "printf '\\377'", "cwd": os.getcwd()})
        self.assertEqual(status, 200)
        self.assertTrue(body["success"])
        self.assertEqual(body["stdout"].encode("utf-8", errors="replace"), b"\xef\xbf\xbd")
        _, timed = self.request("POST", "/exec", {"command": "sleep 2", "cwd": os.getcwd(), "timeoutMs": 10})
        self.assertFalse(timed["success"])
        self.assertEqual(timed["exitCode"], 124)

    def test_token_is_not_in_child_environment(self):
        _, body = self.request("POST", "/exec", {"command": "printf '%s' \"${MARIMOHUB_AGENT_TOKEN:-}\"", "cwd": os.getcwd()})
        self.assertEqual(body["stdout"], "")

    def test_binary_file_write_and_read(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "nested", "file.bin")
            content = bytes(range(256))
            encoded = base64.b64encode(content).decode()
            self.request("POST", "/files/write", {"files": [{"path": path, "contentBase64": encoded}]})
            _, body = self.request("GET", "/files/read?path=" + urllib.parse.quote(path, safe=""))
            self.assertEqual(base64.b64decode(body["contentBase64"]), content)

    def test_single_large_file_and_preferred_batch_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "large.bin")
            content = b"a" * (9 * 1024 * 1024)
            status, _ = self.request(
                "POST",
                "/files/write",
                {"files": [{"path": path, "contentBase64": base64.b64encode(content).decode()}]},
            )
            self.assertEqual(status, 200)
            too_many = b"b" * (5 * 1024 * 1024)
            with self.assertRaises(urllib.error.HTTPError) as failure:
                self.request(
                    "POST",
                    "/files/write",
                    {
                        "files": [
                            {"path": path + "-1", "contentBase64": base64.b64encode(too_many).decode()},
                            {"path": path + "-2", "contentBase64": base64.b64encode(too_many).decode()},
                        ]
                    },
                )
            self.assertEqual(failure.exception.code, 413)
            too_large = b"c" * (25 * 1024 * 1024 + 1)
            with self.assertRaises(urllib.error.HTTPError) as failure:
                self.request(
                    "POST",
                    "/files/write",
                    {"files": [{"path": path + "-too-large", "contentBase64": base64.b64encode(too_large).decode()}]},
                )
            self.assertEqual(failure.exception.code, 413)

    def test_env_precedence(self):
        self.request("POST", "/env", {"defaults": {"MH_ENV": "default"}, "forced": {"MH_ENV": "forced"}})
        _, body = self.request("POST", "/exec", {"command": "printf '%s' \"$MH_ENV\"", "cwd": os.getcwd()})
        self.assertEqual(body["stdout"], "forced")

    def test_process_waits_for_port_and_kills_group(self):
        _, process = self.request(
            "POST",
            "/processes",
            {"command": "python3 -c 'import time; time.sleep(10)'", "cwd": os.getcwd()},
        )
        process_id = process["id"]
        with self.assertRaises(urllib.error.HTTPError) as failure:
            self.request("POST", f"/processes/{process_id}/wait-port", {"port": 1, "timeoutMs": 10})
        self.assertIn(failure.exception.code, {408, 409})
        request = urllib.request.Request(
            self.base + f"/processes/{process_id}?signal=TERM",
            headers={"Authorization": f"Bearer {TOKEN}"},
            method="DELETE",
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            self.assertEqual(response.status, 204)

    def test_process_logs_keep_tail_and_duplicate_ids_are_rejected(self):
        _, process = self.request(
            "POST",
            "/processes",
            {
                "processId": "duplicate-id",
                "command": "python3 -c 'import sys; sys.stdout.write(\"x\" * 70000 + \"READY\")'",
                "cwd": os.getcwd(),
            },
        )
        with self.assertRaises(urllib.error.HTTPError) as failure:
            self.request(
                "POST",
                "/processes",
                {"processId": "duplicate-id", "command": "sleep 1", "cwd": os.getcwd()},
            )
        self.assertEqual(failure.exception.code, 409)
        time.sleep(0.1)
        _, logs = self.request("GET", f"/processes/{process['id']}/logs")
        self.assertIn("READY", logs["stdout"])

    def test_process_timeout_cleans_up_finished_process(self):
        _, process = self.request(
            "POST",
            "/processes",
            {"processId": "short-lived", "command": "sleep 10", "cwd": os.getcwd(), "timeoutMs": 20},
        )
        time.sleep(0.1)
        _, logs = self.request("GET", f"/processes/{process['id']}/logs")
        self.assertEqual(logs["stdout"], "")
        with self.assertRaises(urllib.error.HTTPError) as failure:
            self.request("GET", f"/processes/{process['id']}/logs")
        self.assertEqual(failure.exception.code, 404)


if __name__ == "__main__":
    unittest.main()
