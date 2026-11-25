/**
 * What the live runner and the hub's follow client share about a run's marimo host: the files
 * the runner keeps beside the run output while the host is up, and the Python both scripts use
 * to talk to it.
 */

/** Written by the runner, read by the follow client: where the host listens and its token. */
export const HOST_DESCRIPTOR_FILE = '.job_host.json';
/** The page a follower mounts, rendered by the runner with the placeholders below. */
export const FOLLOW_SHELL_FILE = '.job_follow.html';
/** The hub replaces these in the shell with its follow endpoint and a follower's token. */
export const FOLLOW_URL_PLACEHOLDER = 'https://marimohub-follow.invalid/runtime';
export const FOLLOW_TOKEN_PLACEHOLDER = 'marimohub-follow-token';

/** Prepended to each script: requests that bypass proxies and redirects, and an SSE reader. */
export const HOST_CLIENT_PYTHON = String.raw`
import json
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


OPENER = build_opener(ProxyHandler({}), NoRedirect())


def call(url, token, method="GET", body=None, headers=None, timeout=30):
    request = Request(url, method=method, data=None if body is None else json.dumps(body).encode(),
                      headers={"Authorization": "Bearer " + token, **(headers or {})})
    if body is not None:
        request.add_header("Content-Type", "application/json")
    return OPENER.open(request, timeout=timeout)


def frames(response):
    """Yield (event, id, data) per SSE frame. Data stays text: marimo emits non-finite numbers
    that a JSON round trip would corrupt."""
    event, data = {}, []
    for line in response:
        line = line.decode(errors="replace").rstrip("\r\n")
        if not line:
            if "event" in event:
                yield event["event"], event.get("id"), "\n".join(data)
            event, data = {}, []
        elif not line.startswith(":"):
            field, _, value = line.partition(":")
            if value.startswith(" "):
                value = value[1:]
            if field in ("event", "id"):
                event[field] = value
            elif field == "data":
                data.append(value)
`;
