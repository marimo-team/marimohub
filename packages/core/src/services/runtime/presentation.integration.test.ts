import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createIntegrationId, createSessionId } from '../../ids';
import { bundleIntegrations } from '../integrations/bundle';
import { prepareMarimoPresentation } from '../marimoConfig';

const python = process.env.MARIMO_INTEGRATION_PYTHON;
const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const program = String.raw`
import json, os, pathlib, socket, subprocess, sys, time, urllib.request
from marimo._session.notebook import AppFileManager

mode = sys.argv[1]
restored = mode == "restored"
manager = AppFileManager("notebook.py")
head = manager.app.config.html_head_file
if restored or mode == "edit":
    assert head == "notebook-head.html", head
else:
    assert head.endswith("/presentation/head.html"), head

if mode == "job":
    subprocess.run([sys.executable, "-m", "marimo", "export", "html", "notebook.py", "-o", "out.html"], check=True, capture_output=True, timeout=30)
    html = pathlib.Path("out.html").read_text()
else:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        # The CLI has no socket option; hand the reservation to its Uvicorn server.
        bootstrap = '''
import runpy, socket, sys, uvicorn
sock = socket.socket(fileno=int(sys.argv[1]))
run = uvicorn.Server.run
def run_with_socket(self, sockets=None):
    return run(self, sockets=[sock])
uvicorn.Server.run = run_with_socket
sys.argv = ["marimo", *sys.argv[2:]]
runpy.run_module("marimo", run_name="__main__")
'''
        process = subprocess.Popen([sys.executable, "-c", bootstrap, str(sock.fileno()), "--quiet", "edit" if mode == "edit" else "run", "notebook.py", "--headless", "--no-token", "--host", "127.0.0.1", "--port", str(port)], pass_fds=(sock.fileno(),), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 20
            while True:
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=1) as response:
                        html = response.read().decode()
                    break
                except OSError:
                    if process.poll() is not None or time.monotonic() > deadline:
                        raise RuntimeError("marimo did not start")
                    time.sleep(0.1)
        finally:
            process.terminate()
            try:
                process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()

from html.parser import HTMLParser
class Assets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_style = False
        self.styles = []
        self.meta = []
        self.scripts = []
    def handle_starttag(self, tag, attrs):
        if tag == "style": self.in_style = True
        if tag == "meta": self.meta.append(dict(attrs).get("name"))
        if tag == "script": self.scripts.append(dict(attrs).get("id"))
    def handle_endtag(self, tag):
        if tag == "style": self.in_style = False
    def handle_data(self, data):
        if self.in_style: self.styles.append(data)
assets = Assets()
assets.feed(html)
print(json.dumps({"css": any("--hub-presentation-test" in css for css in assets.styles), "head": "hub-presentation-test" in assets.meta, "notebookHead": "notebook-head-test" in assets.meta, "cssBreakout": "css-breakout" in assets.meta, "headScript": "head-script-test" in assets.scripts}))
`;

describe.runIf(Boolean(python))('native marimo presentation', () => {
	it.each(['edit', 'app', 'job', 'restored'] as const)(
		'applies current presentation in %s mode',
		async (mode) => {
			const root = await mkdtemp(join(tmpdir(), 'mhub-presentation-'));
			roots.push(root);
			const resolve = (path: string) => join(root, path);
			const bundle = bundleIntegrations(
				[
					{
						id: createIntegrationId(),
						name: 'theme',
						kind: 'custom_css',
						version: 1,
						output: {
							presentation: {
								css: ':root { --hub-presentation-test: purple; }\n/* </style><meta name="css-breakout"> */',
								htmlHead:
									'<meta name="hub-presentation-test" content="enabled"><script id="head-script-test">window.presentationTest = true;</script>',
							},
						},
					},
				],
				{ kind: 'session', id: createSessionId() },
			);
			const previous = prepareMarimoPresentation(bundle, resolve, { mode: 'app' })!;
			const env = prepareMarimoPresentation(mode === 'restored' ? undefined : bundle, resolve, {
				mode: mode === 'restored' ? 'app' : mode,
				restored: mode === 'restored',
			})!;
			for (const file of [
				...(mode === 'restored' ? (previous.files ?? []) : []),
				...(env.files ?? []),
			]) {
				const path = resolve(file.path);
				await mkdir(dirname(path), { recursive: true });
				await writeFile(path, file.content);
			}
			await writeFile(join(root, 'notebook-head.html'), '<meta name="notebook-head-test">');
			await writeFile(
				join(root, 'notebook.py'),
				`import marimo
app = marimo.App(html_head_file="notebook-head.html")
@app.cell
def _():
    import marimo as mo
    mo.md("Presentation test")
    return
`,
			);
			const { stdout } = await exec(python!, ['-c', program, mode], {
				cwd: root,
				env: {
					...process.env,
					...(mode === 'restored' ? previous.vars : {}),
					...env.defaults,
					...env.vars,
					HOME: root,
				},
				timeout: 60_000,
			});
			expect(JSON.parse(stdout)).toEqual(
				mode === 'restored'
					? { css: false, head: false, notebookHead: true, cssBreakout: false, headScript: false }
					: {
							css: true,
							head: mode !== 'edit',
							notebookHead: false,
							cssBreakout: false,
							headScript: mode !== 'edit',
						},
			);
		},
		65_000,
	);
});
