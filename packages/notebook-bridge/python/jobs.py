"""Visitor-scoped job calls for hosted marimo apps."""
import json
from urllib.request import HTTPRedirectHandler, Request, build_opener


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_UNSET = object()


class Jobs:
    def __init__(self, request=_UNSET):
        if request is _UNSET:
            import marimo as mo

            request = mo.app_meta().request
        if request is None:
            raise RuntimeError("Open this notebook as a hosted app to use jobs")
        # marimo excludes x-marimo* headers from app_meta().request.
        self._endpoint = request.headers.get("x-mhub-app-jobs-url")
        self._credential = request.headers.get("x-mhub-app-jobs-credential")
        if not self._endpoint or not self._credential:
            raise RuntimeError("Open this notebook as a hosted app to use jobs")

    @classmethod
    def from_request(cls, request):
        return cls(request)

    def _send(self, operation, body):
        request = Request(
            self._endpoint + "/" + operation,
            data=json.dumps(body).encode(),
            headers={"Authorization": "Bearer " + self._credential,
                     "Content-Type": "application/json"},
            method="POST",
        )
        with build_opener(_NoRedirect).open(request, timeout=30) as response:
            return json.load(response)["data"]

    def _call(self, operation, body):
        self._credential = self._send("refresh", {})["credential"]
        return self._send(operation, body)

    def trigger(self, job_id, *, parameters=None, tags=None):
        payload = {}
        if parameters is not None:
            payload["parameters"] = parameters
        if tags is not None:
            payload["tags"] = tags
        return self._call("trigger", {"job_id": job_id, "input": payload})

    def get_run(self, job_id, run_id):
        return self._call("get_run", {"job_id": job_id, "run_id": run_id})

    def list_active_runs(self, job_id):
        return self._call("list_active_runs", {"job_id": job_id})

    def list_history(self, *, tag_key=None, tag_value=None, status=None,
                     triggered_by=None, triggered_by_me=False, limit=None, cursor=None):
        """Read one project history page; follow next_cursor even on empty pages."""
        body = {key: value for key, value in {
            "tag_key": tag_key, "tag_value": tag_value, "status": status,
            "triggered_by": triggered_by, "limit": limit, "cursor": cursor,
        }.items() if value is not None}
        if triggered_by_me:
            body["triggered_by_me"] = "true"
        return self._call("list_history", body)
