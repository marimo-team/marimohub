import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configuration, renderComment, runPreview } from './preview.mjs';

function fixture(overrides = {}) {
	const inputs = {
		'hub-url': 'https://hub.example.com',
		'hub-token': 'secret',
		'github-token': 'github-secret',
		'project-id': 'proj',
		'notebook-id': 'nb',
		...overrides,
	};
	const input = (key) => inputs[key] ?? '';
	const calls = [];
	const outputs = {};
	const summaries = [];
	const warnings = [];
	const item = {
		id: 'prev-1',
		url: 'https://hub.example.com/preview/1',
		name: 'feature/chart',
		target_commit: 'a'.repeat(40),
		preparation: 'deferred',
	};
	const result = { state: 'active', pending: false, items: [item] };
	const marker = renderComment(configuration(input), result).marker;
	const options = {
		input,
		event: {
			action: 'synchronize',
			repository: { full_name: 'owner/repo' },
			pull_request: {
				number: 42,
				head: { sha: 'a'.repeat(40), repo: { full_name: 'owner/repo' } },
			},
		},
		env: {
			GITHUB_EVENT_NAME: 'pull_request',
			GITHUB_REPOSITORY: 'owner/repo',
			GITHUB_RUN_ID: '123',
			GITHUB_SHA: 'merge-sha',
		},
		fetch: async (url, init) => {
			calls.push({ url, init });
			if (url.includes('/actions/runs/'))
				return Response.json({
					id: 123,
					workflow_id: 4,
					run_number: 5,
					created_at: '2026-01-01T00:00:00Z',
				});
			if (url.endsWith('/reconcile')) return Response.json({ success: true, data: result });
			if (url.includes('/comments?'))
				return Response.json([{ id: 7, user: { type: 'Bot' }, body: marker }]);
			return Response.json({ id: 7 });
		},
		summary: async (value) => {
			summaries.push(value);
		},
		output: async (name, value) => {
			outputs[name] = value;
		},
		warning: (value) => warnings.push(value),
	};
	return { options, calls, outputs, summaries, warnings, result };
}

await test('uses PR head and original run identity, patches one comment, and exposes outputs', async () => {
	const { options, calls, outputs, summaries } = fixture({
		eager: 'false',
		mode: 'commits',
		keep: '3',
		'idle-days': '2',
	});
	await runPreview(options);
	const body = JSON.parse(calls.find((call) => call.url.endsWith('/reconcile')).init.body);
	assert.equal(body.commit, 'a'.repeat(40));
	assert.equal(body.workflow_id, '4');
	assert.equal(body.run_id, '123');
	assert.equal(body.run_number, 5);
	assert.deepEqual(body.policy, { mode: 'commits', keep: 3, eager: false, idle_days: 2 });
	assert.ok(
		calls.some((call) => call.url.endsWith('/issues/comments/7') && call.init.method === 'PATCH'),
	);
	assert.deepEqual(JSON.parse(outputs['preview-ids']), ['prev-1']);
	assert.deepEqual(JSON.parse(outputs.commits), ['a'.repeat(40)]);
	assert.match(summaries[0], /deferred/);
});

await test('skips forks before reading secrets or calling APIs', async () => {
	const { options, calls, summaries } = fixture();
	options.event.pull_request.head.repo.full_name = 'fork/repo';
	options.input = () => {
		throw new Error('should not read input');
	};
	await runPreview(options);
	assert.equal(calls.length, 0);
	assert.match(summaries[0], /skipped/);
});

await test('comment failures preserve successful outputs and summary', async () => {
	const { options, outputs, summaries, warnings } = fixture();
	const fetch = options.fetch;
	options.fetch = (url, init) =>
		url.includes('/comments')
			? Promise.resolve(new Response('', { status: 403 }))
			: fetch(url, init);
	await runPreview(options);
	assert.ok(outputs.previews);
	assert.equal(summaries.length, 1);
	assert.equal(warnings.length, 1);
});

await test('closure updates the sticky comment to retired', async () => {
	const { options, result, summaries, outputs } = fixture();
	options.event.action = 'closed';
	result.state = 'closed';
	result.items = [];
	await runPreview(options);
	assert.match(summaries[0], /retired/);
	assert.equal(outputs.previews, '[]');
});

await test('creates a comment when there is no matching bot comment', async () => {
	const { options, calls } = fixture();
	const fetch = options.fetch;
	options.fetch = (url, init) =>
		url.includes('/comments?') ? Promise.resolve(Response.json([])) : fetch(url, init);
	await runPreview(options);
	assert.ok(
		calls.some((call) => call.url.endsWith('/issues/42/comments') && call.init.method === 'POST'),
	);
});

await test('validates input ranges and booleans', () => {
	for (const overrides of [
		{ eager: 'yes' },
		{ keep: '0' },
		{ keep: '26' },
		{ 'idle-days': '31' },
		{ mode: 'lru' },
		{ 'hub-url': 'https://user:password@hub.example.com' },
	])
		assert.throws(() => fixture(overrides));
});

await test('does not disclose Hub error bodies or tokens', async () => {
	const { options } = fixture();
	const fetch = options.fetch;
	options.fetch = (url, init) =>
		url.endsWith('/reconcile')
			? Promise.resolve(new Response('secret', { status: 403 }))
			: fetch(url, init);
	await assert.rejects(
		runPreview(options),
		(error) => !error.message.includes('secret') && error.message.includes('403'),
	);
});

await test('GitHub run lookup failures stop before contacting the Hub', async () => {
	for (const status of [401, 403, 404, 429, 503]) {
		const { options, outputs, summaries } = fixture();
		const calls = [];
		options.fetch = async (url) => {
			calls.push(url);
			return new Response('private upstream diagnostic', { status });
		};
		await assert.rejects(runPreview(options), new RegExp(`GitHub request failed \\(${status}\\)`));
		assert.equal(calls.length, 1);
		assert.deepEqual(outputs, {});
		assert.deepEqual(summaries, []);
	}
});

await test('Hub authorization, conflict, capacity, and server failures never publish links', async () => {
	for (const status of [401, 403, 409, 429, 503]) {
		const { options, calls, outputs, summaries } = fixture();
		const fetch = options.fetch;
		options.fetch = (url, init) =>
			url.endsWith('/reconcile')
				? Promise.resolve(new Response('private diagnostic', { status }))
				: fetch(url, init);
		await assert.rejects(
			runPreview(options),
			new RegExp(`Hub preview reconciliation failed \\(${status}\\)`),
		);
		assert.deepEqual(outputs, {});
		assert.deepEqual(summaries, []);
		assert.ok(calls.every((call) => !call.url.includes('/comments')));
	}
});

await test('a disconnected Hub does not publish a success comment or outputs', async () => {
	const { options, calls, outputs } = fixture();
	const fetch = options.fetch;
	options.fetch = (url, init) =>
		url.endsWith('/reconcile') ? Promise.reject(new TypeError('fetch failed')) : fetch(url, init);
	await assert.rejects(runPreview(options), /fetch failed/);
	assert.deepEqual(outputs, {});
	assert.ok(calls.every((call) => !call.url.includes('/comments')));
});

await test('malformed successful responses do not expose response bodies or emit outputs', async () => {
	for (const target of ['github', 'hub']) {
		const { options, outputs } = fixture();
		const fetch = options.fetch;
		options.fetch = (url, init) =>
			(target === 'github' ? url.includes('/actions/runs/') : url.endsWith('/reconcile'))
				? Promise.resolve(new Response('secret diagnostic'))
				: fetch(url, init);
		await assert.rejects(
			runPreview(options),
			(error) => !error.message.includes('secret diagnostic'),
		);
		assert.deepEqual(outputs, {});
	}
});

await test('rejects invalid preview URLs before writing outputs', async () => {
	const { options, result, outputs, summaries } = fixture();
	// eslint-disable-next-line no-script-url -- Untrusted API response fixture.
	result.items[0].url = 'javascript:alert(1)';
	await assert.rejects(runPreview(options), /Invalid preview URL/);
	assert.deepEqual(outputs, {});
	assert.deepEqual(summaries, []);
});

await test('finds the sticky comment on a later page without creating a duplicate', async () => {
	const { options, calls } = fixture();
	const fetch = options.fetch;
	const pages = [];
	options.fetch = (url, init) => {
		if (url.includes('/comments?')) {
			pages.push(url);
			if (url.endsWith('page=1'))
				return Promise.resolve(
					Response.json(
						Array.from({ length: 100 }, (_, id) => ({
							id,
							body: 'unrelated',
							user: { type: 'Bot' },
						})),
					),
				);
		}
		return fetch(url, init);
	};
	await runPreview(options);
	assert.equal(pages.length, 2);
	assert.ok(
		calls.some((call) => call.url.endsWith('/issues/comments/7') && call.init.method === 'PATCH'),
	);
	assert.ok(
		calls.every(
			(call) => !(call.url.endsWith('/issues/42/comments') && call.init.method === 'POST'),
		),
	);
});

await test('does not edit a human comment that copies the automation marker', async () => {
	const { options, calls } = fixture();
	const fetch = options.fetch;
	options.fetch = async (url, init) => {
		const response = await fetch(url, init);
		if (!url.includes('/comments?')) return response;
		const comments = await response.json();
		comments[0].user.type = 'User';
		return Response.json(comments);
	};
	await runPreview(options);
	assert.ok(
		calls.some((call) => call.url.endsWith('/issues/42/comments') && call.init.method === 'POST'),
	);
	assert.ok(calls.every((call) => call.init.method !== 'PATCH'));
});

await test('rejects unsupported events and mismatched repositories before network access', async () => {
	for (const change of ['event', 'action', 'repository']) {
		const { options, calls } = fixture();
		if (change === 'event') options.env.GITHUB_EVENT_NAME = 'push';
		if (change === 'action') options.event.action = 'labeled';
		if (change === 'repository') options.env.GITHUB_REPOSITORY = 'other/repo';
		await assert.rejects(runPreview(options));
		assert.equal(calls.length, 0);
	}
});

await test('reports capacity waiting without inventing a preview link', async () => {
	const { options, result, outputs, summaries } = fixture();
	result.pending = true;
	result.items = [];
	await runPreview(options);
	assert.equal(outputs.previews, '[]');
	assert.match(summaries[0], /waiting for project capacity/);
});

await test('requires HTTPS except for explicit loopback hosts', () => {
	for (const url of [
		'https://hub.example.com/prefix',
		'http://localhost:8080/prefix',
		'http://127.0.0.1:8080',
		'http://127.1.2.3:8080',
		'http://[::1]:8080',
	]) {
		const { options } = fixture({ 'hub-url': url });
		assert.equal(configuration(options.input).hub, url);
	}
	for (const url of [
		'http://hub.example.com',
		'http://10.0.0.1',
		'http://0.0.0.0',
		'http://127.evil.example.com',
		'http://127.0.0.1.evil.example.com',
		'http://localhost.evil.example.com',
		'http://localhost@evil.example.com',
		'http://[::2]',
		'ftp://localhost',
	])
		assert.throws(() => fixture({ 'hub-url': url }), /hub-url must use HTTPS/);
});

await test('rejects insecure Hub URLs before sending either token', async () => {
	const { options, calls, outputs } = fixture();
	const input = options.input;
	options.input = (name) => (name === 'hub-url' ? 'http://hub.example.com' : input(name));
	await assert.rejects(runPreview(options), /hub-url must use HTTPS/);
	assert.equal(calls.length, 0);
	assert.deepEqual(outputs, {});
});

const execFile = promisify(execFileCallback);
async function entrypoint({
	event = JSON.stringify(fixture().options.event),
	env = {},
	preload,
} = {}) {
	const directory = await mkdtemp(join(tmpdir(), 'preview-action-'));
	try {
		const eventPath = join(directory, 'event.json');
		const outputPath = join(directory, 'output');
		const summaryPath = join(directory, 'summary');
		const preloadPath = join(directory, 'fetch.mjs');
		await Promise.all([
			writeFile(eventPath, event),
			writeFile(outputPath, ''),
			writeFile(summaryPath, ''),
			writeFile(
				preloadPath,
				preload ?? "globalThis.fetch = () => { throw new Error('Unexpected request'); };",
			),
		]);
		const result = await execFile(
			process.execPath,
			['--import', preloadPath, fileURLToPath(new URL('./index.mjs', import.meta.url))],
			{
				timeout: 10_000,
				env: {
					...fixture().options.env,
					GITHUB_EVENT_PATH: eventPath,
					GITHUB_OUTPUT: outputPath,
					GITHUB_STEP_SUMMARY: summaryPath,
					'INPUT_HUB-URL': 'https://hub.example.com',
					'INPUT_HUB-TOKEN': 'hub-secret',
					'INPUT_GITHUB-TOKEN': 'github-secret',
					'INPUT_PROJECT-ID': 'proj',
					'INPUT_NOTEBOOK-ID': 'nb',
					...env,
				},
			},
		).then(
			(result) => ({ ...result, status: 0 }),
			(error) => ({ stdout: error.stdout, stderr: error.stderr, status: error.code }),
		);
		return {
			...result,
			output: await readFile(outputPath, 'utf8'),
			summary: await readFile(summaryPath, 'utf8'),
		};
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

await test('entrypoint masks escaped secrets before reading a fork event and exits successfully', async () => {
	const event = fixture().options.event;
	event.pull_request.head.repo.full_name = 'fork/repo';
	const result = await entrypoint({
		event: JSON.stringify(event),
		env: { 'INPUT_HUB-TOKEN': 'hub%\r\nsecret', 'INPUT_GITHUB-TOKEN': 'github%\nsecret' },
	});
	assert.equal(result.status, 0);
	assert.equal(result.stdout, '::add-mask::hub%25%0D%0Asecret\n::add-mask::github%25%0Asecret\n');
	assert.equal(result.stderr, '');
	assert.equal(result.output, '');
	assert.match(result.summary, /skipped for fork pull requests/);
});

await test('entrypoint reports invalid or missing event files without leaking their contents', async () => {
	for (const overrides of [
		{ event: 'private diagnostic: not JSON' },
		{ env: { GITHUB_EVENT_PATH: '/missing-preview-event.json' } },
	]) {
		const result = await entrypoint(overrides);
		assert.equal(result.status, 1);
		assert.equal(
			result.stdout,
			'::add-mask::hub-secret\n::add-mask::github-secret\n::error::Unable to read GitHub event file\n',
		);
		assert.equal(result.stderr, '');
		assert.equal(result.output, '');
		assert.equal(result.summary, '');
	}
});

await test('entrypoint escapes workflow errors and returns a failing exit code', async () => {
	const result = await entrypoint({
		preload: `globalThis.fetch = () => { throw new Error(${JSON.stringify('network%\r\nfailed')}); };`,
	});
	assert.equal(result.status, 1);
	assert.equal(
		result.stdout,
		'::add-mask::hub-secret\n::add-mask::github-secret\n::error::network%25%0D%0Afailed\n',
	);
	assert.equal(result.stderr, '');
	assert.equal(result.output, '');
	assert.equal(result.summary, '');
});

await test('entrypoint writes outputs and summary when comment permissions fail', async () => {
	const { result: previews } = fixture();
	const result = await entrypoint({
		preload: `globalThis.fetch = async (url) => {
			if (url.includes('/actions/runs/')) return Response.json({ id: 123, workflow_id: 4, run_number: 5, created_at: '2026-01-01T00:00:00Z' });
			if (url.endsWith('/reconcile')) return Response.json(${JSON.stringify({ success: true, data: previews })});
			return new Response('', { status: 403 });
		};`,
	});
	assert.equal(result.status, 0);
	assert.match(result.stdout, /^::add-mask::hub-secret\n::add-mask::github-secret\n::warning::/);
	assert.equal(result.stderr, '');
	assert.match(result.summary, /feature\/chart/);
	const outputs = Object.fromEntries(
		result.output
			.trim()
			.split('\n')
			.map((line) => {
				const separator = line.indexOf('=');
				return [line.slice(0, separator), JSON.parse(line.slice(separator + 1))];
			}),
	);
	assert.deepEqual(outputs['preview-ids'], ['prev-1']);
	assert.deepEqual(outputs['preview-urls'], [previews.items[0].url]);
	assert.deepEqual(outputs.commits, [previews.items[0].target_commit]);
	assert.equal(outputs.previews[0].preparation, 'deferred');
});
