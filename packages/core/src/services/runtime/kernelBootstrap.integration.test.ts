import { spawn, exec as nodeExec } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SandboxInstance } from '../../ports/sandbox';
import { bootstrapKernel } from './kernelBootstrap';
import { createKernelAuthToken, KERNEL_AUTH_TOKEN_FILE } from './kernelAuth';
import { executeInKernel, listKernelSessions } from './kernelExecute';

const python = process.env.MARIMO_INTEGRATION_PYTHON;
const exec = promisify(nodeExec);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function runtime(autoRun: boolean, prefix = '', fault?: 'fail' | 'delay') {
	const root = await mkdtemp(join(tmpdir(), 'mhub-bootstrap-'));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const token = createKernelAuthToken();
	const tokenFile = join(root, 'token');
	await writeFile(tokenFile, token, { mode: 0o600 });
	await writeFile(join(root, '.marimo.toml'), `[runtime]\nauto_instantiate = ${autoRun}\n`);
	await writeFile(
		join(root, 'notebook.py'),
		`import marimo
app = marimo.App()
@app.cell
def _():
    from pathlib import Path
    _p = Path("runs.txt")
    _p.write_text(_p.read_text() + "x" if _p.exists() else "x")
    initial_value = 41
    return (initial_value,)
if __name__ == "__main__":
    app.run()
`,
	);
	const serverMain = String.raw`
import os, socket, sys

if __name__ == "__main__":
    # Keep the same bound socket across exec; --port remains visible to discovery.
    fd = os.environ.pop("MARIMO_TEST_SOCKET_FD", None)
    if fd is None:
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        listener.set_inheritable(True)
        os.environ["MARIMO_TEST_SOCKET_FD"] = str(listener.fileno())
        os.execv(sys.executable, [sys.executable, *sys.argv, "--port", str(listener.getsockname()[1])])
    listener = socket.socket(fileno=int(fd))
    print(listener.getsockname()[1], flush=True)

    import uvicorn
    original_run = uvicorn.Server.run
    uvicorn.Server.run = lambda self: original_run(self, sockets=[listener])
    if ${fault ? 'True' : 'False'}:
        from marimo._session.session import SessionImpl as Session
        original = Session.instantiate
        def faulty(self, *args, **kwargs):
            Session.instantiate = original
            if ${fault === 'fail' ? 'True' : 'False'}:
                raise RuntimeError("private initialization error")
            original(self, *args, **kwargs)
            import time
            time.sleep(2)
        Session.instantiate = faulty
    from marimo._cli.cli import main
    main(prog_name="marimo")
`;
	await writeFile(join(root, 'server.py'), serverMain);
	const child = spawn(
		python!,
		[
			join(root, 'server.py'),
			'--quiet',
			'edit',
			'notebook.py',
			'--headless',
			'--token',
			'--token-password-file',
			tokenFile,
			'--host',
			'127.0.0.1',
			...(prefix ? [`--base-url=${prefix}`] : []),
		],
		{
			cwd: root,
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: true,
		},
	);
	cleanup.push(async () => {
		if (child.exitCode === null && child.pid) {
			const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
			process.kill(-child.pid, 'SIGKILL');
			await exited;
		}
	});
	let output = '';
	let stderr = '';
	child.stdout.on('data', (value: Buffer) => {
		output += value.toString();
	});
	child.stderr.on('data', (value: Buffer) => {
		stderr += value.toString();
	});
	await expect
		.poll(
			() => {
				if (child.exitCode !== null) throw new Error(`marimo exited: ${stderr}`);
				return output.includes('\n');
			},
			{ timeout: 15_000 },
		)
		.toBe(true);
	const port = Number(output.split('\n')[0]);
	expect(port).toBeGreaterThan(0);
	const base = `http://127.0.0.1:${port}${prefix}`;
	await expect
		.poll(
			async () => {
				try {
					return (
						await fetch(`${base}/`, {
							headers: { Authorization: `Bearer ${token}` },
							signal: AbortSignal.timeout(1_000),
						})
					).status;
				} catch {
					return 0;
				}
			},
			{ timeout: 15_000 },
		)
		.toBe(200);
	const sandbox = {
		async exec(command, options) {
			try {
				const result = await exec(command.replaceAll(KERNEL_AUTH_TOKEN_FILE, tokenFile), {
					timeout: options?.timeout,
					maxBuffer: 1024 * 1024,
				});
				return { success: true, ...result };
			} catch {
				return { success: false, stdout: '', stderr: '', error: { code: 'COMMAND_FAILED' } };
			}
		},
	} as SandboxInstance;
	const request = { kernelAuthToken: token };
	return {
		root,
		tokenFile,
		base,
		token,
		sandbox,
		request,
		async execute(code: string) {
			const sessions = await listKernelSessions(base, request);
			expect(sessions).toHaveLength(1);
			return executeInKernel(
				base,
				{ sessionId: sessions[0].id, code },
				{ ...request, timeoutMs: 15_000 },
			);
		},
	};
}

async function attachBrowser(rt: Awaited<ReturnType<typeof runtime>>, autoRun?: boolean) {
	const browser = String.raw`
import json, sys
from html.parser import HTMLParser
from urllib.request import Request, urlopen
from websockets.sync.client import connect
cfg = json.loads(sys.stdin.readline())
auth = {"Authorization": "Bearer " + cfg["token"]}
with connect(cfg["base"].replace("http:", "ws:") + "/ws?session_id=browser-session", additional_headers=auth) as ws:
    while True:
        event = json.loads(ws.recv(timeout=15))
        if event.get("op") == "kernel-ready":
            break
    if "autoRun" in cfg:
        class Token(HTMLParser):
            def handle_starttag(self, tag, attrs):
                if tag == "marimo-server-token":
                    self.value = dict(attrs)["data-token"]
        token = Token()
        with urlopen(Request(cfg["base"] + "/", headers=auth), timeout=15) as response:
            token.feed(response.read().decode())
        headers = {**auth, "Marimo-Server-Token": token.value,
                   "Marimo-Session-Id": "browser-session", "Content-Type": "application/json"}
        body = json.dumps({"objectIds": [], "values": [], "autoRun": cfg["autoRun"]}).encode()
        with urlopen(Request(cfg["base"] + "/api/kernel/instantiate", data=body, headers=headers), timeout=15) as response:
            assert json.load(response)["success"] is True
    print(json.dumps(event["data"]), flush=True)
    sys.stdin.readline()
`;
	const browserProcess = spawn(python!, ['-c', browser], { stdio: 'pipe' });
	browserProcess.stdin.write(`${JSON.stringify({ base: rt.base, token: rt.token, autoRun })}\n`);
	cleanup.push(async () => {
		browserProcess.kill();
	});
	let output = '';
	browserProcess.stdout.on('data', (value: Buffer) => {
		output += value.toString();
	});
	await expect.poll(() => output.includes('\n'), { timeout: 15_000 }).toBe(true);
	const ready = JSON.parse(output.split('\n')[0]) as {
		resumed: boolean;
		codes: string[];
		cell_ids: string[];
	};
	return { browserProcess, ready };
}

describe.skipIf(!python)('real marimo headless bootstrap', () => {
	it.each([true, false])(
		'initializes with auto execution %s, serializes starts, and preserves state',
		async (autoRun) => {
			const rt = await runtime(autoRun, '/nested/prefix');
			expect(await bootstrapKernel(rt.sandbox, { timeoutMs: 5_000, inspectOnly: true })).toEqual({
				status: 'initializing',
			});
			expect(await listKernelSessions(rt.base, rt.request)).toEqual([]);
			const starts = await Promise.all(
				[1, 2, 3].map(() => bootstrapKernel(rt.sandbox, { timeoutMs: 15_000 })),
			);
			expect(starts).toEqual(Array(3).fill({ status: 'ready' }));
			const initial = await rt.execute('print(globals().get("initial_value", "disabled"))');
			expect(initial).toMatchObject({
				completed: true,
				success: true,
				stdout: autoRun ? '41\n' : 'disabled\n',
			});
			expect(
				await rt.execute(`import marimo._code_mode as cm
async with cm.get_context() as ctx:
    cid = ctx.create_cell("live_values = []")
    ctx.run_cell(cid)
`),
			).toMatchObject({ success: true });
			expect(await rt.execute('live_values.append(99)')).toMatchObject({ success: true });
			expect(await bootstrapKernel(rt.sandbox, { timeoutMs: 15_000 })).toEqual({ status: 'ready' });
			expect(await rt.execute('print(live_values[0])')).toMatchObject({ stdout: '99\n' });
			expect(
				await rt.execute(
					'from pathlib import Path; print(Path("runs.txt").read_text() if Path("runs.txt").exists() else "disabled")',
				),
			).toMatchObject({ stdout: autoRun ? 'x\n' : 'disabled\n' });
			expect(await bootstrapKernel(rt.sandbox, { timeoutMs: 5_000, inspectOnly: true })).toEqual({
				status: 'ready',
			});
		},
		60_000,
	);

	it('rejects invalid authentication without exposing credentials', async () => {
		const rt = await runtime(true);
		await writeFile(rt.tokenFile, createKernelAuthToken());
		expect(await bootstrapKernel(rt.sandbox, { timeoutMs: 5_000 })).toEqual({
			status: 'unavailable',
		});
		expect(await listKernelSessions(rt.base, rt.request)).toEqual([]);
	}, 30_000);

	it.each(['fail', 'delay'] as const)(
		'recovers from initialization %s without rerunning cells',
		async (fault) => {
			const rt = await runtime(true, '', fault);
			expect(
				await bootstrapKernel(rt.sandbox, { timeoutMs: fault === 'delay' ? 1_000 : 5_000 }),
			).toEqual({ status: fault === 'delay' ? 'initializing' : 'unavailable' });
			expect(await bootstrapKernel(rt.sandbox, { timeoutMs: 10_000 })).toEqual({ status: 'ready' });
			expect(
				await rt.execute('from pathlib import Path; print(Path("runs.txt").read_text())'),
			).toMatchObject({ success: true, stdout: 'x\n' });
		},
		30_000,
	);

	it('retries initialization within one wait window without rerunning cells', async () => {
		const rt = await runtime(true, '', 'delay');
		const probe = vi.spyOn(rt.sandbox, 'exec');
		expect(await bootstrapKernel(rt.sandbox, { timeoutMs: 10_000 })).toEqual({ status: 'ready' });
		expect(probe.mock.calls.length).toBeGreaterThan(1);
		expect(
			await rt.execute('from pathlib import Path; print(Path("runs.txt").read_text())'),
		).toMatchObject({ success: true, stdout: 'x\n' });
	}, 30_000);

	it.each([true, false])(
		'inspects a browser-created kernel with auto execution %s',
		async (autoRun) => {
			const rt = await runtime(autoRun, '/browser/prefix');
			const { browserProcess } = await attachBrowser(rt, autoRun);
			expect(await bootstrapKernel(rt.sandbox, { timeoutMs: 5_000, inspectOnly: true })).toEqual({
				status: 'ready',
			});
			expect((await listKernelSessions(rt.base, rt.request))[0].id).toBe('browser-session');
			expect(browserProcess.exitCode).toBeNull();
			expect(await rt.execute('print(globals().get("initial_value", "disabled"))')).toMatchObject({
				success: true,
				stdout: autoRun ? '41\n' : 'disabled\n',
			});
			expect(
				await rt.execute(
					'from pathlib import Path; print(Path("runs.txt").read_text() if Path("runs.txt").exists() else "disabled")',
				),
			).toMatchObject({ stdout: autoRun ? 'x\n' : 'disabled\n' });
		},
		30_000,
	);

	it('a browser resumes variables and editable cells under a new session ID', async () => {
		const rt = await runtime(true);
		expect(await bootstrapKernel(rt.sandbox, { timeoutMs: 15_000 })).toEqual({ status: 'ready' });
		expect(
			await rt.execute(`import marimo._code_mode as cm
async with cm.get_context() as ctx:
    cid = ctx.create_cell("edited_value = 17; live_values = []")
    ctx.run_cell(cid)
`),
		).toMatchObject({ success: true });
		expect(await rt.execute('live_values.append(73)')).toMatchObject({ success: true });
		const oldId = (await listKernelSessions(rt.base, rt.request))[0].id;
		const { browserProcess, ready } = await attachBrowser(rt);
		expect(ready.resumed).toBe(true);
		expect(ready.codes).toContain('edited_value = 17; live_values = []');
		const newId = (await listKernelSessions(rt.base, rt.request))[0].id;
		expect(newId).toBe('browser-session');
		expect(newId).not.toBe(oldId);
		expect(await bootstrapKernel(rt.sandbox, { timeoutMs: 5_000, inspectOnly: true })).toEqual({
			status: 'ready',
		});
		expect(await rt.execute('print(live_values[0], initial_value)')).toMatchObject({
			success: true,
			stdout: '73 41\n',
		});
		expect(await bootstrapKernel(rt.sandbox, { timeoutMs: 15_000 })).toEqual({ status: 'ready' });
		expect((await listKernelSessions(rt.base, rt.request))[0].id).toBe(newId);
		expect(browserProcess.exitCode).toBeNull();
		const cellId = ready.cell_ids[ready.codes.indexOf('edited_value = 17; live_values = []')];
		expect(
			await rt.execute(`import marimo._code_mode as cm
async with cm.get_context() as ctx:
    ctx.edit_cell(${JSON.stringify(cellId)}, code="edited_value = 23")
print(cm.get_context().cells[${JSON.stringify(cellId)}].code)
`),
		).toMatchObject({ success: true, stdout: expect.stringContaining('edited_value = 23\n') });
		const stale = await fetch(`${rt.base}/api/kernel/execute`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${rt.token}`,
				'Content-Type': 'application/json',
				'Marimo-Session-Id': oldId,
			},
			body: JSON.stringify({ code: 'raise Exception("must not execute")' }),
		});
		expect(stale.status).toBe(500);
		expect(await stale.json()).toMatchObject({ detail: `Invalid session id: ${oldId}` });
	}, 60_000);
});
