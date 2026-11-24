import { describe, expect, it } from 'vitest';
import type { AuthenticatedPrincipal } from '../../ports/auth';
import type { SandboxInstance, SandboxProvider } from '../../ports/sandbox';
import type { JobRun } from '../../schema';
import { ACTOR, makeFakeSandbox } from '../../testing';
import {
	connectRunSandbox,
	isLiveRun,
	readRunEvents,
	readRunFollowShell,
	signRunFollowToken,
	verifyRunFollowToken,
} from './runFollow';
import type { LiveJobRun } from './runFollow';

const RUN = {
	status: 'running',
	sandbox_id: 'sb-1',
	reconnect_reference: 'ref-1',
	live: { workdir: '/workspace' },
} as unknown as LiveJobRun;

const PRINCIPAL = {
	id: ACTOR,
	email: 'follower@example.com',
	credential: { kind: 'sso' },
} as unknown as AuthenticatedPrincipal;

const CLAIMS = {
	principal: PRINCIPAL,
	projectId: 'p1',
	notebookId: 'n1',
	jobId: 'j1',
	runId: 'r1',
	expiresAt: 2_000,
} as unknown as Parameters<typeof signRunFollowToken>[0];

function sandboxReplying(stdout: string, success = true): SandboxInstance & { commands: string[] } {
	const { instance } = makeFakeSandbox();
	const commands: string[] = [];
	instance.exec = async (command) => {
		commands.push(command);
		return success
			? { success: true, stdout, stderr: '' }
			: { success: false, stdout: '', stderr: '', error: { code: 'COMMAND_FAILED' } };
	};
	return Object.assign(instance, { commands });
}

describe('isLiveRun', () => {
	it('requires a running run that executes under a host in a known sandbox', () => {
		expect(isLiveRun(RUN)).toBe(true);
		expect(isLiveRun({ ...RUN, status: 'succeeded' } as JobRun)).toBe(false);
		expect(isLiveRun({ ...RUN, live: undefined } as JobRun)).toBe(false);
		expect(isLiveRun({ ...RUN, sandbox_id: undefined } as JobRun)).toBe(false);
	});
});

describe('connectRunSandbox', () => {
	it('attaches by reference and never falls back to create', () => {
		const { instance } = makeFakeSandbox();
		const attached: unknown[] = [];
		const provider = {
			create: () => {
				throw new Error('must not create');
			},
			connectExisting: (id: string, options: unknown) => {
				attached.push([id, options]);
				return instance;
			},
		} as unknown as SandboxProvider;

		expect(connectRunSandbox(provider, RUN)).toBe(instance);
		expect(attached).toEqual([['sb-1', { reconnectReference: 'ref-1' }]]);
		expect(
			connectRunSandbox({ create: provider.create } as unknown as SandboxProvider, RUN),
		).toBeUndefined();
	});
});

describe('readRunEvents', () => {
	it('passes the descriptor and cursor to the in-sandbox client and keeps event data verbatim', async () => {
		const sandbox = sandboxReplying(
			JSON.stringify({ events: [{ event: 'output', id: 'e:2', data: '{"value":NaN}' }] }),
		);

		expect(await readRunEvents(sandbox, RUN, "e:1'; rm -rf /")).toEqual({
			events: [{ event: 'output', id: 'e:2', data: '{"value":NaN}' }],
		});
		expect(sandbox.commands[0]).toContain("'/workspace/__marimo__/.job_host.json'");
		expect(sandbox.commands[0].endsWith(` 'e:1'\\''; rm -rf /'`)).toBe(true);
	});

	it('reports a host that is not serving', async () => {
		expect(await readRunEvents(sandboxReplying('{"gone": true}'), RUN, undefined)).toEqual({
			gone: true,
		});
	});

	it.each(['{"error": true}', 'not json', '{"events": [{"event": ""}]}'])(
		'rejects the malformed reply %s',
		async (stdout) => {
			await expect(readRunEvents(sandboxReplying(stdout), RUN, undefined)).rejects.toMatchObject({
				code: 'SERVICE_UNAVAILABLE',
			});
		},
	);

	it('rejects a failed command', async () => {
		await expect(readRunEvents(sandboxReplying('', false), RUN, undefined)).rejects.toMatchObject({
			code: 'SERVICE_UNAVAILABLE',
		});
	});
});

describe('readRunFollowShell', () => {
	const shell = (body: string) =>
		makeFakeSandbox({ files: { '/workspace/__marimo__/.job_follow.html': body } }).instance;
	const PAGE =
		'<script>{"runtimeConfig": [{"url": "https://marimohub-follow.invalid/runtime", "authToken": "marimohub-follow-token"}]}</script>';

	it('binds the page to the follow endpoint and token without breaking out of its script', async () => {
		const html = await readRunFollowShell(shell(PAGE), RUN, {
			url: 'https://hub.example/api/run-follow/v1',
			token: 'tok"</script><script>alert(1)',
		});

		expect(html).toBe(
			'<script>{"runtimeConfig": [{"url": "https://hub.example/api/run-follow/v1", "authToken": "tok\\"\\u003c/script>\\u003cscript>alert(1)"}]}</script>',
		);
	});

	it('is absent before the host starts and rejects a page without placeholders', async () => {
		const target = { url: 'https://hub.example/f', token: 't' };
		expect(await readRunFollowShell(makeFakeSandbox().instance, RUN, target)).toBeUndefined();
		await expect(readRunFollowShell(shell('<html></html>'), RUN, target)).rejects.toMatchObject({
			code: 'SERVICE_UNAVAILABLE',
		});
	});
});

describe('run follow tokens', () => {
	it('round-trips claims without exposing them in the token', async () => {
		const token = await signRunFollowToken(CLAIMS, 'secret');

		expect(token).toMatch(/^mhub_follow_[A-Za-z0-9_-]+$/);
		expect(
			atob(token.slice('mhub_follow_'.length).replaceAll('-', '+').replaceAll('_', '/')),
		).not.toContain('follower@example.com');
		expect(await verifyRunFollowToken(token, 'secret', 1_000)).toMatchObject({
			runId: 'r1',
			principal: { email: 'follower@example.com' },
		});
	});

	it('rejects expired, tampered, foreign-secret, and malformed tokens', async () => {
		const token = await signRunFollowToken(CLAIMS, 'secret');
		const flipped = `${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}`;

		expect(await verifyRunFollowToken(token, 'secret', 2_000)).toBeNull();
		expect(await verifyRunFollowToken(flipped, 'secret', 1_000)).toBeNull();
		expect(await verifyRunFollowToken(token, 'other', 1_000)).toBeNull();
		expect(await verifyRunFollowToken('mhub_follow_', 'secret', 1_000)).toBeNull();
		expect(await verifyRunFollowToken('mhub_app_abc', 'secret', 1_000)).toBeNull();
	});
});
