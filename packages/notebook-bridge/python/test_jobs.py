import io
import json
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from urllib.error import HTTPError
from types import SimpleNamespace
from unittest.mock import Mock, patch

from jobs import Jobs


def visitor_request(token, endpoint="https://hub.test/api/app-jobs/v1"):
    return SimpleNamespace(headers={
        "x-mhub-app-jobs-url": endpoint,
        "x-mhub-app-jobs-credential": token,
    })


def visitor(token, endpoint="https://hub.test/api/app-jobs/v1"):
    return Jobs.from_request(visitor_request(token, endpoint))


class JobsTest(unittest.TestCase):
    def test_helpers_keep_each_visitors_refreshed_credentials(self):
        calls = []

        def respond(request, timeout):
            token = request.headers["Authorization"]
            calls.append((request.full_url, token))
            if request.full_url.endswith("/refresh"):
                data = {"credential": token.removeprefix("Bearer ") + "-renewed"}
            else:
                data = {"triggered_by": token}
            return io.BytesIO(json.dumps({"success": True, "data": data}).encode())

        requests = [visitor_request(token) for token in ["alice", "bob"]]
        app_meta = Mock(side_effect=[SimpleNamespace(request=request) for request in requests])
        with patch.dict("sys.modules", {"marimo": SimpleNamespace(app_meta=app_meta)}):
            alice, bob = Jobs(), Jobs()
        self.assertEqual(app_meta.call_count, 2)
        with patch("jobs.build_opener", return_value=SimpleNamespace(open=respond)):
            self.assertEqual(alice.trigger("job")["triggered_by"], "Bearer alice-renewed")
            self.assertEqual(bob.list_active_runs("job")["triggered_by"], "Bearer bob-renewed")
            self.assertEqual(alice.get_run("job", "run")["triggered_by"], "Bearer alice-renewed-renewed")
        self.assertEqual([url.rsplit("/", 1)[-1] for url, _ in calls], [
            "refresh", "trigger", "refresh", "list_active_runs", "refresh", "get_run",
        ])

    def test_refresh_failure_never_submits_a_run(self):
        client = visitor("expired")
        for status in [401, 403, 503]:
            with self.subTest(status=status):
                error = HTTPError("https://hub.test", status, "failure", {}, None)
                with patch("jobs.build_opener") as opener:
                    opener.return_value.open.side_effect = error
                    with self.assertRaises(HTTPError):
                        client.trigger("job")
                    opener.return_value.open.assert_called_once()
                    self.assertTrue(opener.return_value.open.call_args.args[0].full_url.endswith("/refresh"))

    def test_uncertain_submission_is_not_retried(self):
        client = visitor("original")
        with patch("jobs.build_opener") as opener:
            opener.return_value.open.side_effect = [
                io.BytesIO(b'{"data":{"credential":"renewed"}}'),
                TimeoutError("response lost after submission"),
            ]
            with self.assertRaises(TimeoutError):
                client.trigger("job")
            self.assertEqual(opener.return_value.open.call_count, 2)

    def test_redirects_do_not_forward_credentials(self):
        paths = []

        class Redirect(BaseHTTPRequestHandler):
            def do_POST(self):
                paths.append(self.path)
                self.send_response(302)
                self.send_header("Location", "/stolen")
                self.end_headers()

            def do_GET(self):
                paths.append(self.path)
                self.send_response(200)
                self.end_headers()

            def log_message(self, *args):
                pass

        with ThreadingHTTPServer(("127.0.0.1", 0), Redirect) as server:
            thread = Thread(target=server.serve_forever)
            thread.start()
            try:
                client = visitor("visitor-secret", f"http://127.0.0.1:{server.server_port}")
                with self.assertRaises(HTTPError) as raised:
                    client.trigger("job")
                self.assertEqual(raised.exception.code, 302)
                self.assertEqual(paths, ["/refresh"])
            finally:
                server.shutdown()
                thread.join()

    def test_explicit_request_does_not_read_marimo_context(self):
        app_meta = Mock(side_effect=AssertionError("unexpected request lookup"))
        with patch.dict("sys.modules", {"marimo": SimpleNamespace(app_meta=app_meta)}):
            visitor("explicit")
        app_meta.assert_not_called()

    def test_default_requires_a_hosted_visitor(self):
        for request in [None, SimpleNamespace(headers={})]:
            app_meta = Mock(return_value=SimpleNamespace(request=request))
            with patch.dict("sys.modules", {"marimo": SimpleNamespace(app_meta=app_meta)}):
                with self.assertRaisesRegex(RuntimeError, "hosted app"):
                    Jobs()

    def test_requires_a_hosted_visitor(self):
        for request in [None, SimpleNamespace(headers={})]:
            with self.assertRaises(RuntimeError):
                Jobs.from_request(request)


if __name__ == "__main__":
    unittest.main()
