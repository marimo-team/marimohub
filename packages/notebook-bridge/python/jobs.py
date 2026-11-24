"""Visitor job calls and execution-scoped updates for hosted marimo apps."""
import json
import os
from urllib.request import HTTPRedirectHandler, Request, build_opener


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _post(endpoint, credential, operation, body):
    request = Request(
        endpoint + "/" + operation,
        data=json.dumps(body, allow_nan=False).encode(),
        headers={"Authorization": "Bearer " + credential,
                 "Content-Type": "application/json"},
        method="POST",
    )
    with build_opener(_NoRedirect).open(request, timeout=30) as response:
        return json.load(response)["data"]


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
        return _post(self._endpoint, self._credential, operation, body)

    def _call(self, operation, body):
        self._credential = self._send("refresh", {})["credential"]
        return self._send(operation, body)

    def trigger(self, job_id, *, parameters=None, tags=None, metadata=None):
        payload = {}
        if parameters is not None:
            payload["parameters"] = parameters
        if metadata is not None:
            payload["metadata"] = metadata
        if tags is not None:
            payload["tags"] = tags
        return self._call("trigger", {"job_id": job_id, "input": payload})

    def get_run(self, job_id, run_id):
        return self._call("get_run", {"job_id": job_id, "run_id": run_id})

    def list_active_runs(self, job_id):
        return self._call("list_active_runs", {"job_id": job_id})

    def list_project_runs(self, *, tag_key=None, tag_value=None, status=None,
                     triggered_by=None, triggered_by_me=False, limit=None, cursor=None):
        """Read one project run page; follow next_cursor even on empty pages."""
        body = {key: value for key, value in {
            "tag_key": tag_key, "tag_value": tag_value, "status": status,
            "triggered_by": triggered_by, "limit": limit, "cursor": cursor,
        }.items() if value is not None}
        if triggered_by_me:
            body["triggered_by_me"] = triggered_by_me
        return self._call("list_project_runs", body)

    def stop(self, job_id, run_id, *, grace_seconds=None):
        payload = {} if grace_seconds is None else {"grace_seconds": grace_seconds}
        return self._call("stop", {"job_id": job_id, "run_id": run_id, "input": payload})


class Run:
    """Execution-scoped updates for the current job attempt."""

    def __init__(self):
        self._endpoint = os.environ.get("MARIMOHUB_RUN_URL")
        self._credential = os.environ.get("MARIMOHUB_RUN_CREDENTIAL")
        if not self._endpoint or not self._credential:
            raise RuntimeError("Run updates require a hosted job execution")

    def _call(self, operation, body):
        return _post(self._endpoint, self._credential, operation, body)

    def get_run(self):
        return self._call("get_run", {})

    def patch_metadata(self, patch):
        """Merge keys into metadata. A None value deletes a key."""
        return self._call("patch_metadata", patch)

    def acknowledge_stop(self):
        """Finish a requested stop after application-owned writes complete."""
        return self._call("acknowledge_stop", {})
