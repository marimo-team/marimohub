import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SandboxId } from '@marimo-hub/core';
import { expectExecResult, expectFileResult } from '@marimo-hub/core/testing';
import { ModalCompute } from './index';

const TOKEN_ID = 'tok_id';
const TOKEN_SECRET = 'tok_secret';
const IMAGE = 'my-image';
const API_BASE = 'https://api.modal.test';
const SANDBOX_ID = 'sb-abc' as SandboxId;

function makeCompute() {
	return new ModalCompute({
		tokenId: TOKEN_ID,
		tokenSecret: TOKEN_SECRET,
		image: IMAGE,
		apiBase: API_BASE,
	});
}

function mockOkResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status });
}

function mockErrorResponse(status = 500) {
	return new Response('internal error', { status });
}

// Parse a captured request body for shape assertions. JSON.parse now returns
// `unknown` (ts-reset), so tests opt back into property access via this helper.
function parseBody(body: unknown): any {
	return JSON.parse(body as string);
}

const mockFetch = vi.fn<typeof fetch>();

beforeEach(() => {
	vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
	vi.unstubAllGlobals();
	mockFetch.mockReset();
});

describe('ModalCompute', () => {
	describe('create().exec()', () => {
		it('POSTs to the exec endpoint with the correct command + headers', async () => {
			mockFetch.mockResolvedValueOnce(mockOkResponse({ exit_code: 0, stdout: 'hi', stderr: '' }));

			const result = await makeCompute().create(SANDBOX_ID).exec('echo hi');

			expectExecResult(result, { success: true, stdout: 'hi', stderr: '' });

			const [url, init] = mockFetch.mock.calls[0];
			expect(String(url)).toBe(`${API_BASE}/v1/sandboxes/${SANDBOX_ID}/exec`);
			expect(init?.method).toBe('POST');
			// ofetch normalizes headers into a Headers instance before calling fetch.
			const headers = new Headers(init?.headers as HeadersInit);
			expect(headers.get('Modal-Key')).toBe(TOKEN_ID);
			expect(headers.get('Modal-Secret')).toBe(TOKEN_SECRET);
			const body = parseBody(init?.body as string);
			expect(body.command).toEqual(['sh', '-lc', 'echo hi']);
		});

		it('returns success=false when exit_code is non-zero', async () => {
			mockFetch.mockResolvedValueOnce(mockOkResponse({ exit_code: 1, stdout: '', stderr: 'err' }));
			const result = await makeCompute().create(SANDBOX_ID).exec('bad-cmd');
			expectExecResult(result, { success: false, stderr: 'err' });
		});

		it('throws when the API returns a non-OK status', async () => {
			mockFetch.mockResolvedValueOnce(mockErrorResponse(500));
			await expect(makeCompute().create(SANDBOX_ID).exec('cmd')).rejects.toThrow(/Modal API/);
		});
	});

	describe('listActive()', () => {
		it('returns only running/undefined-state sandboxes with well-formed ids', async () => {
			mockFetch.mockResolvedValueOnce(
				mockOkResponse({
					sandboxes: [
						{ sandbox_id: 'sb-aaaaaaaaaaaaaaaa', state: 'running' },
						{ id: 'sb-bbbbbbbbbbbbbbbb' }, // state undefined → live
						{ sandbox_id: 'sb-cccccccccccccccc', state: 'stopped' }, // excluded by state
						{ sandbox_id: '', state: 'running' }, // empty id — excluded
						{ sandbox_id: 'modal-native-id', state: 'running' }, // not our id — excluded
					],
				}),
			);
			const active = await makeCompute().listActive();
			expect(active.map((s) => s.id).sort()).toEqual([
				'sb-aaaaaaaaaaaaaaaa',
				'sb-bbbbbbbbbbbbbbbb',
			]);
		});

		it('GETs the sandboxes list endpoint with app_name scoping', async () => {
			mockFetch.mockResolvedValueOnce(mockOkResponse({ sandboxes: [] }));
			const compute = new ModalCompute({
				tokenId: TOKEN_ID,
				tokenSecret: TOKEN_SECRET,
				image: IMAGE,
				apiBase: API_BASE,
				appName: 'myapp',
			});
			await compute.listActive();
			const [url, init] = mockFetch.mock.calls[0];
			expect(String(url)).toContain('app_name=myapp');
			expect(init?.method).toBe('GET');
		});

		it('handles missing sandboxes array (returns empty)', async () => {
			mockFetch.mockResolvedValueOnce(mockOkResponse({}));
			expect(await makeCompute().listActive()).toEqual([]);
		});
	});

	describe('create().gitCheckout()', () => {
		it('issues a shell-quoted git clone (injection-safe via compute-commons)', async () => {
			mockFetch.mockResolvedValueOnce(mockOkResponse({ exit_code: 0, stdout: '', stderr: '' }));
			await makeCompute().create(SANDBOX_ID).gitCheckout('https://x/y; rm -rf /', {
				branch: 'main',
				targetDir: 'w',
			});
			const body = parseBody(mockFetch.mock.calls[0][1]?.body as string);
			// The malicious repo string is safely quoted, not interpolated raw.
			expect(body.command).toEqual([
				'sh',
				'-lc',
				"git clone --branch 'main' 'https://x/y; rm -rf /' 'w'",
			]);
		});

		it('throws when the clone fails', async () => {
			mockFetch.mockResolvedValueOnce(
				mockOkResponse({ exit_code: 128, stdout: '', stderr: 'fatal: repo' }),
			);
			await expect(makeCompute().create(SANDBOX_ID).gitCheckout('https://x/y')).rejects.toThrow(
				/git checkout failed: fatal: repo/,
			);
		});
	});

	describe('create().startProcess()', () => {
		it('starts a process and returns a process whose methods hit the right endpoints', async () => {
			mockFetch
				.mockResolvedValueOnce(mockOkResponse({ process_id: 'p1' })) // startProcess
				.mockResolvedValueOnce(mockOkResponse({})) // kill
				.mockResolvedValueOnce(mockOkResponse({})) // waitForPort
				.mockResolvedValueOnce(mockOkResponse({ stdout: 'out', stderr: 'err' })); // getLogs

			const proc = await makeCompute()
				.create(SANDBOX_ID)
				.startProcess('uv run marimo edit', {
					cwd: '/workspace',
					env: { A: '1' },
				});

			// startProcess request shape
			const [startUrl, startInit] = mockFetch.mock.calls[0];
			expect(String(startUrl)).toBe(`${API_BASE}/v1/sandboxes/${SANDBOX_ID}/processes`);
			const startBody = parseBody(startInit?.body as string);
			expect(startBody.command).toEqual(['sh', '-lc', 'uv run marimo edit']);
			expect(startBody.cwd).toBe('/workspace');
			expect(startBody.env).toEqual({ A: '1' });

			// returned process identity
			expect(proc.id).toBe('p1');
			expect(proc.command).toBe('uv run marimo edit');

			await proc.kill('SIGTERM');
			expect(String(mockFetch.mock.calls[1][0])).toBe(
				`${API_BASE}/v1/sandboxes/${SANDBOX_ID}/processes/p1/kill`,
			);
			expect(parseBody(mockFetch.mock.calls[1][1]?.body as string).signal).toBe('SIGTERM');

			await proc.waitForPort(8080, { path: '/health' });
			const wfpBody = parseBody(mockFetch.mock.calls[2][1]?.body as string);
			expect(String(mockFetch.mock.calls[2][0])).toBe(
				`${API_BASE}/v1/sandboxes/${SANDBOX_ID}/wait-for-port`,
			);
			expect(wfpBody).toMatchObject({ port: 8080, mode: 'http', path: '/health' });

			const logs = await proc.getLogs();
			expect(logs).toEqual({ stdout: 'out', stderr: 'err' });
			expect(String(mockFetch.mock.calls[3][0])).toBe(
				`${API_BASE}/v1/sandboxes/${SANDBOX_ID}/processes/p1/logs`,
			);
		});

		it('waitForPort defaults the mode to http when unspecified', async () => {
			mockFetch
				.mockResolvedValueOnce(mockOkResponse({ process_id: 'p1' }))
				.mockResolvedValueOnce(mockOkResponse({}));
			const proc = await makeCompute().create(SANDBOX_ID).startProcess('run');
			await proc.waitForPort(9000);
			expect(parseBody(mockFetch.mock.calls[1][1]?.body as string).mode).toBe('http');
		});
	});

	describe('create().exposePort()', () => {
		it('POSTs to the tunnels endpoint and unwraps the public url', async () => {
			mockFetch.mockResolvedValueOnce(mockOkResponse({ url: 'https://tunnel.modal/abc' }));
			const result = await makeCompute()
				.create(SANDBOX_ID)
				.exposePort(2718, { hostname: 'ignored' });
			expect(result).toEqual({ url: 'https://tunnel.modal/abc' });
			const [url, init] = mockFetch.mock.calls[0];
			expect(String(url)).toBe(`${API_BASE}/v1/sandboxes/${SANDBOX_ID}/tunnels`);
			expect(parseBody(init?.body as string).port).toBe(2718);
		});
	});

	describe('create().destroy()', () => {
		it('POSTs to the terminate endpoint', async () => {
			mockFetch.mockResolvedValueOnce(mockOkResponse({}));
			await makeCompute().create(SANDBOX_ID).destroy();
			expect(String(mockFetch.mock.calls[0][0])).toBe(
				`${API_BASE}/v1/sandboxes/${SANDBOX_ID}/terminate`,
			);
		});
	});

	describe('create().execStream()', () => {
		it('streams from the exec endpoint with ?stream=1 and returns the body', async () => {
			mockFetch.mockResolvedValueOnce(new Response('chunk', { status: 200 }));
			const stream = await makeCompute().create(SANDBOX_ID).execStream('tail -f log');
			expect(stream).toBeInstanceOf(ReadableStream);
			expect(String(mockFetch.mock.calls[0][0])).toContain('?stream=1');
		});

		it('throws when the response is not OK', async () => {
			mockFetch.mockResolvedValueOnce(mockErrorResponse(500));
			await expect(makeCompute().create(SANDBOX_ID).execStream('x')).rejects.toThrow(
				/exec stream failed/,
			);
		});

		it('throws when the response has no body', async () => {
			mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
			await expect(makeCompute().create(SANDBOX_ID).execStream('x')).rejects.toThrow(
				/exec stream failed/,
			);
		});
	});

	describe('create() file ops', () => {
		it('readFile returns the content on success', async () => {
			mockFetch.mockResolvedValueOnce(mockOkResponse({ content: 'hello' }));
			const res = await makeCompute().create(SANDBOX_ID).readFile('/f.txt');
			expectFileResult(res, { success: true, content: 'hello', encoding: 'utf-8' });
		});

		it('readFile swallows API errors into success:false (provisioner fallback contract)', async () => {
			mockFetch.mockResolvedValueOnce(mockErrorResponse(404));
			const res = await makeCompute().create(SANDBOX_ID).readFile('/missing');
			expectFileResult(res, { success: false, content: '' });
		});

		it('writeFile POSTs the path and content', async () => {
			mockFetch.mockResolvedValueOnce(mockOkResponse({}));
			await makeCompute().create(SANDBOX_ID).writeFile('/f.txt', 'data');
			const [url, init] = mockFetch.mock.calls[0];
			expect(String(url)).toBe(`${API_BASE}/v1/sandboxes/${SANDBOX_ID}/files/write`);
			expect(parseBody(init?.body as string)).toEqual({ path: '/f.txt', content: 'data' });
		});

		it('listFiles returns files, defaulting a missing array to []', async () => {
			mockFetch.mockResolvedValueOnce(mockOkResponse({}));
			expect(await makeCompute().create(SANDBOX_ID).listFiles('/')).toEqual({
				success: true,
				files: [],
			});
		});

		it('setEnvVars POSTs the env map', async () => {
			mockFetch.mockResolvedValueOnce(mockOkResponse({}));
			await makeCompute().create(SANDBOX_ID).setEnvVars({ FOO: 'bar' });
			const [url, init] = mockFetch.mock.calls[0];
			expect(String(url)).toBe(`${API_BASE}/v1/sandboxes/${SANDBOX_ID}/env`);
			expect(parseBody(init?.body as string)).toEqual({ env: { FOO: 'bar' } });
		});
	});

	describe('unsupported / no-op surface', () => {
		it('mountBucket throws to trigger the file-copy fallback (no network call)', async () => {
			await expect(
				makeCompute().create(SANDBOX_ID).mountBucket({
					bucketName: 'b',
					endpoint: 'e',
					mountPath: '/m',
					prefix: 'p',
				}),
			).rejects.toThrow(/file copy fallback/);
			expect(mockFetch).not.toHaveBeenCalled();
		});

		it('unmountBucket is a no-op', async () => {
			await expect(makeCompute().create(SANDBOX_ID).unmountBucket('/m')).resolves.toBeUndefined();
			expect(mockFetch).not.toHaveBeenCalled();
		});

		it('proxy returns null (Modal kernels are reached directly)', async () => {
			expect(await makeCompute().proxy(new Request('https://x/'))).toBeNull();
		});
	});

	describe('config defaults', () => {
		it('falls back to the default API base when apiBase is unset', async () => {
			mockFetch.mockResolvedValueOnce(mockOkResponse({ exit_code: 0, stdout: '', stderr: '' }));
			const compute = new ModalCompute({
				tokenId: TOKEN_ID,
				tokenSecret: TOKEN_SECRET,
				image: IMAGE,
			});
			await compute.create(SANDBOX_ID).exec('echo');
			expect(String(mockFetch.mock.calls[0][0])).toMatch(/^https:\/\/api\.modal\.com\//);
		});

		it('falls back to the default app name in listActive when appName is unset', async () => {
			mockFetch.mockResolvedValueOnce(mockOkResponse({ sandboxes: [] }));
			const compute = new ModalCompute({
				tokenId: TOKEN_ID,
				tokenSecret: TOKEN_SECRET,
				image: IMAGE,
			});
			await compute.listActive();
			expect(String(mockFetch.mock.calls[0][0])).toContain('app_name=marimohub');
		});
	});
});
