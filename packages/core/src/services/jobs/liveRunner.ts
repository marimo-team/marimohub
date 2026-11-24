import {
	FOLLOW_SHELL_FILE,
	FOLLOW_TOKEN_PLACEHOLDER,
	FOLLOW_URL_PLACEHOLDER,
	HOST_CLIENT_PYTHON,
	HOST_DESCRIPTOR_FILE,
} from './liveRunHost';

/**
 * Runs a job notebook once under a marimo host, inside the sandbox and the notebook's Python
 * environment, in place of `marimo export html`. The host makes the run observable while it
 * executes; the run's exit status and rendered HTML keep the export contract:
 *
 * - exit 0: every cell succeeded; exit 1: a cell failed. Both write the HTML.
 * - exit 2: the host or the runner failed after cells started, and no HTML is written.
 *
 * The HTML comes from the finished session, so the notebook executes exactly once. If the host
 * cannot serve the notebook at all, no cell has run, and the runner becomes `marimo export html`.
 * The server binds loopback only and its tokens stay in a private temporary directory.
 */
export const JOB_LIVE_RUNNER = `${HOST_CLIENT_PYTHON}${String.raw`
import os, signal, socket, subprocess, sys, tempfile, time, uuid
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote, urlsplit

STARTUP_SECONDS = 120
# The host pings every 15 seconds; three missed pings mean the stream is dead.
STREAM_SILENCE_SECONDS = 45
RECONNECTS = 5
HOST_DESCRIPTOR = ${JSON.stringify(HOST_DESCRIPTOR_FILE)}
FOLLOW_SHELL = ${JSON.stringify(FOLLOW_SHELL_FILE)}
FOLLOW_URL = ${JSON.stringify(FOLLOW_URL_PLACEHOLDER)}
FOLLOW_TOKEN = ${JSON.stringify(FOLLOW_TOKEN_PLACEHOLDER)}


class RunnerError(Exception):
    pass


class HostUnavailable(RunnerError):
    """The marimo host never served the notebook, so no cell has executed."""


def records(response):
    for name, event_id, data in frames(response):
        yield name, event_id, json.loads(data or "{}")


def discover(port, process, log):
    try:
        from marimo._utils.xdg import marimo_state_dir
    except ImportError:
        raise HostUnavailable("this marimo release has no host protocol") from None

    deadline = time.monotonic() + STARTUP_SECONDS
    while time.monotonic() < deadline and process.poll() is None:
        for path in (marimo_state_dir() / "hosts-v1").glob("*.json"):
            try:
                record = json.loads(path.read_text())
                url = urlsplit(record["url"])
                if (record["version"] == 1 and url.hostname == "127.0.0.1" and url.port == port
                        and record["process"]["pid"] == process.pid):
                    return record
            except (OSError, ValueError, KeyError, TypeError):
                continue
        time.sleep(0.1)
    log.seek(0)
    raise HostUnavailable("marimo did not start:\n" + log.read().decode(errors="replace")[-1500:].strip())


def find_notebook(record, notebook, process):
    deadline = time.monotonic() + STARTUP_SECONDS
    while True:
        try:
            response = call(record["url"] + "/events?kinds=project,notebook", record["token"])
            break
        except OSError:
            # The discovery record can precede the listening socket.
            if process.poll() is not None or time.monotonic() > deadline:
                raise HostUnavailable("the marimo host is unreachable") from None
            time.sleep(0.1)
    with response:
        projects, notebooks = {}, []
        for name, _, data in records(response):
            if name == "project":
                projects[data["project"]["id"]] = data["project"]
            elif name == "notebook":
                notebooks.append(data["notebook"])
            elif name == "ready":
                break
    matches = [n for n in notebooks if n.get("path") is not None
               and projects.get(n["project_id"], {}).get("root") is not None
               and (Path(projects[n["project_id"]]["root"]) / n["path"]).resolve() == notebook]
    if len(matches) != 1:
        raise HostUnavailable("the marimo host does not list the notebook")
    return matches[0]["id"]


class Follower:
    """Start the runtime, submit every cell as one run, and report it until it completes."""

    def __init__(self, record, notebook_id):
        self.base = record["url"] + "/notebooks/" + quote(notebook_id, safe="")
        self.token = record["token"]
        self.cells, self.names, self.console, self.states = {}, {}, {}, {}
        self.started = False
        self.run_id = None
        self.outcome = None

    def post(self, method, path, body):
        try:
            with call(self.base + path, self.token, method, body,
                      {"Idempotency-Key": str(uuid.uuid4())}) as response:
                return json.loads(response.read())
        except HTTPError as error:
            raise RunnerError(f"{method} {path} failed with status {error.code}") from None

    def observe(self, name, data):
        if name == "cell":
            cell = data["cell"]
            self.cells[cell["id"]] = cell
            self.names[cell["id"]] = cell.get("name") if cell.get("name") not in (None, "_") else cell["id"]
        elif name == "console":
            item = data["console"]
            content = item["content"]
            if item["execution_id"] in self.states and content["kind"] == "text":
                previous = self.console.get(item["id"], "")
                target = sys.stderr if content["stream"] == "stderr" else sys.stdout
                target.write(content["text"].removeprefix(previous))
                target.flush()
                self.console[item["id"]] = content["text"]
        elif name == "execution":
            execution = data["execution"]
            state = execution["state"]
            # Results restored from an earlier session name no run.
            if (self.run_id is None or execution["run_id"] != self.run_id
                    or self.states.get(execution["id"]) == state["status"]):
                return
            self.states[execution["id"]] = state["status"]
            if state["status"] == "completed" and state["outcome"]["kind"] == "failed":
                error = state["outcome"]["error"]
                label = self.names.get(execution["cell_id"], execution["cell_id"])
                print(f"[{label}] {error.get('name') or 'Error'}: {error.get('message')}", file=sys.stderr, flush=True)
        elif name == "run" and data["run"]["id"] == self.run_id:
            state = data["run"]["state"]
            if state["status"] == "completed":
                self.outcome = state["outcome"]["kind"]
        elif name == "runtime":
            state = data["runtime"]["state"]
            if state["status"] == "ended" and self.started and self.outcome is None:
                raise RunnerError("The marimo runtime ended before the run completed")
            if state["status"] == "ready" and self.run_id is None and self.started and self.outcome is None:
                self.submit()

    def submit(self):
        if not self.cells:
            # An empty notebook still needs its session for the export.
            self.outcome = "succeeded"
            return
        run = self.post("POST", "/runtime/runs", {
            "cells": [{"id": cell["id"], "etag": cell["etag"]} for cell in self.cells.values()]})
        self.run_id = run["id"]
        if run["state"]["status"] == "completed":
            self.outcome = run["state"]["outcome"]["kind"]

    def follow(self):
        cursor, failures = None, 0
        while self.outcome is None:
            headers = {"Accept": "text/event-stream", "Marimo-Attachment-Identity": "marimohub-job",
                       "Marimo-Attachment-Kind": "client", "Marimo-Attachment-Name": "marimohub job runner"}
            if cursor:
                headers["Last-Event-ID"] = cursor
            try:
                with call(self.base + "/events?kinds=cell,runtime,run,execution,console", self.token,
                          headers=headers, timeout=STREAM_SILENCE_SECONDS) as response:
                    for name, event_id, data in records(response):
                        failures = 0
                        cursor = event_id or cursor
                        self.observe(name, data)
                        if name == "ready" and not self.started:
                            self.started = True
                            runtime = self.post("PUT", "/runtime", {})
                            if runtime["state"]["status"] == "ready":
                                self.submit()
                        if self.outcome is not None:
                            break
            except (OSError, ValueError) as error:
                failures += 1
                if failures > RECONNECTS:
                    raise RunnerError(f"Lost the marimo event stream ({type(error).__name__})") from None
                time.sleep(min(2 ** failures, 10) / 4)
        return self.outcome


def stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def write_whole(path, text, mode=0o644):
    """Readers see the old file or the new one, never part of one."""
    temporary = path.with_name(path.name + ".tmp")
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode), "w") as file:
        file.write(text)
    temporary.replace(path)


def own_stylesheets(html):
    # The frontend copies stylesheets into its plugin shadow roots only when they are titled
    # as its own, come from its CDN path, or share the page origin. The hub shows these pages
    # in a sandboxed frame, which has no origin, so any other asset host would be skipped.
    return html.replace('<link rel="stylesheet"', '<link rel="stylesheet" title="marimo"')


def write_follow_shell(notebook, path, asset_url):
    """Render the page a follower mounts: the marimo frontend bound to a remote read-only stream."""
    try:
        from marimo._internal.templates import render_notebook
        from marimo._templates import get_default_asset_url

        html = render_notebook(
            code=notebook.read_text(), mode="read", filename=notebook.name,
            config={"server": {"transport": "sse"}},
            runtime_config=[{"url": FOLLOW_URL, "authToken": FOLLOW_TOKEN}],
            asset_url=asset_url or get_default_asset_url())
        write_whole(path, own_stylesheets(html))
    except Exception as error:
        # Following is optional; the run itself must not depend on it.
        print(f"marimohub: follow view unavailable ({type(error).__name__})", file=sys.stderr)


def export_html(server, access_token, notebook_id, output, asset_url):
    with call(server + "/api/sessions", access_token) as response:
        sessions = json.loads(response.read())
    session_ids = [key for key, value in sessions.items() if value.get("notebook_id") == notebook_id]
    if len(session_ids) != 1:
        raise RunnerError("The notebook session ended before its output could be exported")
    body = {"download": False, "files": [], "includeCode": True}
    if asset_url:
        body["assetUrl"] = asset_url
    with call(server + "/api/export/html", access_token, "POST", body,
              {"Marimo-Session-Id": session_ids[0]}, timeout=120) as response:
        write_whole(output, own_stylesheets(response.read().decode()))


def main():
    arguments = sys.argv[1:]
    passthrough = []
    if "--" in arguments:
        index = arguments.index("--")
        arguments, passthrough = arguments[:index], arguments[index:]
    options = {}
    while len(arguments) >= 5 and arguments[-2] in ("--asset-url", "--launcher"):
        options[arguments[-2]] = arguments[-1]
        arguments = arguments[:-2]
    if len(arguments) != 3 or arguments[1] != "-o":
        print("usage: runner <notebook> -o <output.html> [--asset-url <url>] [--launcher <path>]"
              " [-- notebook arguments]", file=sys.stderr)
        return 2
    asset_url = options.get("--asset-url")
    # The hub's launcher installs its job client into this environment, then runs marimo.
    marimo = [sys.executable, options["--launcher"]] if "--launcher" in options else [
        sys.executable, "-m", "marimo"]
    notebook, output = Path(arguments[0]).resolve(), Path(arguments[2]).resolve()
    process = None
    unavailable = None
    descriptor = output.with_name(HOST_DESCRIPTOR)
    shell = output.with_name(FOLLOW_SHELL)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    with tempfile.TemporaryDirectory(prefix="marimohub-job-") as directory:
        token_path = Path(directory) / "token"
        access_token = uuid.uuid4().hex
        token_path.write_text(access_token)
        token_path.chmod(0o600)
        try:
            # A saved session would show an earlier run's results until each cell reruns.
            (notebook.parent / "__marimo__" / "session" / (notebook.name + ".json")).unlink(missing_ok=True)
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", 0))
                port = probe.getsockname()[1]
            with (Path(directory) / "server.log").open("w+b") as log:
                # The same process group lets the caller's timeout stop the server with the runner.
                process = subprocess.Popen([
                    *marimo, "edit", str(notebook), "--headless", "--no-sandbox",
                    "--skip-update-check", "--no-skew-protection", "--host", "127.0.0.1",
                    "--port", str(port), "--token-password-file", str(token_path),
                    "--config", "runtime.auto_instantiate=false",
                    "--config", "runtime.on_cell_change=lazy", *passthrough,
                ], stdin=subprocess.DEVNULL, stdout=log, stderr=log)
                record = discover(port, process, log)
                notebook_id = find_notebook(record, notebook, process)
            write_follow_shell(notebook, shell, asset_url)
            # Followers inside the sandbox read the stream through this descriptor.
            write_whole(descriptor, json.dumps({
                "url": record["url"], "token": record["token"], "notebook_id": notebook_id}), 0o600)
            outcome = Follower(record, notebook_id).follow()
            export_html(f"http://127.0.0.1:{port}", access_token, notebook_id, output, asset_url)
            return 0 if outcome == "succeeded" else 1
        except HostUnavailable as error:
            unavailable = str(error)
        except RunnerError as error:
            print(error, file=sys.stderr)
            return 2
        except (OSError, ValueError, KeyError) as error:
            print(f"The marimo host failed ({type(error).__name__})", file=sys.stderr)
            return 2
        finally:
            descriptor.unlink(missing_ok=True)
            shell.unlink(missing_ok=True)
            if process is not None:
                stop(process)
    # No cell has executed, so the plain export can still run the notebook exactly once.
    print("marimohub: this run cannot be followed (" + unavailable + "); exporting without a live view",
          file=sys.stderr, flush=True)
    sys.stdout.flush()
    os.execv(sys.executable, [*marimo, "export", "html", str(notebook), "-o", str(output), *passthrough])


if __name__ == "__main__":
    sys.exit(main())
`}`;
