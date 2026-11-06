import { createHash } from 'node:crypto';

const EVENTS = new Set(['opened', 'reopened', 'synchronize', 'closed']);

function integer(value, fallback, max, name) {
	const input = value || fallback;
	if (!/^\d+$/.test(input) || Number(input) < 1 || Number(input) > max)
		throw new Error(`${name} must be an integer from 1 to ${max}`);
	return Number(input);
}

export function configuration(input) {
	const required = (key) => {
		const value = input(key).trim();
		if (!value) throw new Error(`Missing input: ${key}`);
		return value;
	};
	const hub = new URL(required('hub-url'));
	const loopback =
		hub.hostname === 'localhost' ||
		hub.hostname === '[::1]' ||
		/^127(?:\.\d{1,3}){3}$/.test(hub.hostname);
	if (
		!(hub.protocol === 'https:' || (hub.protocol === 'http:' && loopback)) ||
		hub.username ||
		hub.password ||
		hub.search ||
		hub.hash
	)
		throw new Error(
			'hub-url must use HTTPS (HTTP is allowed only on loopback), without credentials, query, or fragment',
		);
	const mode = input('mode') || 'sticky';
	const eager = input('eager') || 'true';
	if (!['sticky', 'commits'].includes(mode)) throw new Error('mode must be sticky or commits');
	if (!['true', 'false'].includes(eager)) throw new Error('eager must be true or false');
	return {
		hub: hub.href.replace(/\/$/, ''),
		project: required('project-id'),
		notebook: required('notebook-id'),
		token: required('hub-token'),
		githubToken: required('github-token'),
		policy: {
			mode,
			keep: integer(input('keep'), '5', 25, 'keep'),
			eager: eager === 'true',
			...(input('idle-days')
				? { idle_days: integer(input('idle-days'), '', 30, 'idle-days') }
				: {}),
		},
	};
}

function markdown(value) {
	return String(value)
		.replaceAll(/[\\`*_[\]<>|]/g, '\\$&')
		.replaceAll(/[\r\n]/g, ' ');
}

export function renderComment(config, result) {
	const key = createHash('sha256')
		.update(JSON.stringify([config.hub, config.project, config.notebook]))
		.digest('hex');
	const marker = `<!-- marimohub-preview:${key} -->`;
	const lines = [marker, '### marimo notebook previews', ''];
	if (result.state !== 'active') lines.push('These previews are retired.');
	else {
		if (result.pending) lines.push('Some previews are waiting for project capacity.', '');
		if (result.items.length === 0) lines.push('No previews are available yet.');
		for (const item of result.items) {
			const url = new URL(item.url);
			if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid preview URL');
			const commit = item.target_commit ?? item.commit;
			lines.push(
				`- [${markdown(item.name)}](<${url.href.replaceAll('>', '%3E')}>) · ${commit ? markdown(commit.slice(0, 12)) : 'pending'} · ${markdown(item.preparation)}`,
			);
		}
		lines.push(
			'',
			'Opening a deferred preview prepares its code. Compute starts when you open an app or editor.',
		);
	}
	return { marker, body: lines.join('\n') };
}

async function responseJson(response, service) {
	try {
		return await response.json();
	} catch {
		throw new Error(`${service} returned invalid JSON`);
	}
}

export async function runPreview({
	input,
	event,
	env,
	fetch: request = globalThis.fetch,
	summary,
	output,
	warning,
}) {
	if (
		!['pull_request', 'pull_request_target'].includes(env.GITHUB_EVENT_NAME) ||
		!EVENTS.has(event.action)
	)
		throw new Error(
			'This action requires a pull request opened, reopened, synchronize, or closed event',
		);
	const pr = event.pull_request;
	if (!pr?.head?.repo || pr.head.repo.full_name !== event.repository?.full_name) {
		await summary('PR previews are skipped for fork pull requests.\n');
		return;
	}
	const config = configuration(input);
	const repo = event.repository.full_name;
	if (repo !== env.GITHUB_REPOSITORY)
		throw new Error('Event repository does not match the workflow');
	const api = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
	const repositoryPath = repo.split('/').map(encodeURIComponent).join('/');
	const github = async (path, method = 'GET', body) => {
		const response = await request(`${api}/repos/${repositoryPath}${path}`, {
			method,
			redirect: 'error',
			signal: AbortSignal.timeout(30_000),
			headers: {
				Authorization: `Bearer ${config.githubToken}`,
				Accept: 'application/vnd.github+json',
				'Content-Type': 'application/json',
			},
			...(body ? { body: JSON.stringify(body) } : {}),
		});
		if (!response.ok) throw new Error(`GitHub request failed (${response.status})`);
		return responseJson(response, 'GitHub');
	};
	const run = await github(`/actions/runs/${encodeURIComponent(env.GITHUB_RUN_ID)}`);
	const body = {
		repository: repo,
		pull_request: pr.number,
		event: event.action,
		commit: pr.head.sha,
		workflow_id: String(run.workflow_id),
		run_id: String(run.id),
		run_number: run.run_number,
		event_at: run.created_at,
		policy: config.policy,
	};
	const response = await request(
		`${config.hub}/api/v1/projects/${encodeURIComponent(config.project)}/notebooks/${encodeURIComponent(config.notebook)}/previews/reconcile`,
		{
			method: 'POST',
			redirect: 'error',
			signal: AbortSignal.timeout(60_000),
			headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		},
	);
	if (!response.ok)
		throw new Error(
			`Hub preview reconciliation failed (${response.status}); check the notebook, token grant, and GitHub App connection`,
		);
	const envelope = await responseJson(response, 'Hub');
	if (!envelope.success) throw new Error('Hub preview reconciliation failed');
	const result = envelope.data;
	const comment = renderComment(config, result);
	const previews = result.items.map((item) => ({
		id: item.id,
		url: item.url,
		commit: item.target_commit ?? item.commit,
		preparation: item.preparation,
	}));
	await output('previews', JSON.stringify(previews));
	await output('preview-ids', JSON.stringify(previews.map((item) => item.id)));
	await output('preview-urls', JSON.stringify(previews.map((item) => item.url)));
	await output('commits', JSON.stringify(previews.map((item) => item.commit)));
	await summary(`${comment.body}\n`);
	try {
		let existing;
		for (let page = 1; ; page++) {
			const comments = await github(`/issues/${pr.number}/comments?per_page=100&page=${page}`);
			existing = comments.find(
				(item) => item.user?.type === 'Bot' && item.body?.includes(comment.marker),
			);
			if (existing || comments.length < 100) break;
		}
		if (existing) await github(`/issues/comments/${existing.id}`, 'PATCH', { body: comment.body });
		else await github(`/issues/${pr.number}/comments`, 'POST', { body: comment.body });
	} catch {
		warning(
			'Previews were accepted, but the PR comment could not be updated. Check pull-requests: write. Links are in the workflow summary.',
		);
	}
}
