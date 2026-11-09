import { createHash } from 'node:crypto';

const EVENTS = new Set(['opened', 'reopened', 'synchronize', 'closed']);

function integer(value, fallback, max, name) {
	const input = value || fallback;
	if (!/^\d+$/.test(input) || Number(input) < 1 || Number(input) > max)
		throw new Error(`${name} must be an integer from 1 to ${max}`);
	return Number(input);
}

function targets(input) {
	const list = input('targets').trim();
	const project = input('project-id').trim();
	const notebook = input('notebook-id').trim();
	if (!list) {
		if (!project || !notebook)
			throw new Error('Provide targets or both project-id and notebook-id');
		return [{ project, notebook }];
	}
	if (project || notebook)
		throw new Error('targets cannot be combined with project-id or notebook-id');
	let entries;
	try {
		entries = JSON.parse(list);
	} catch {
		throw new Error('targets must be a JSON array');
	}
	if (!Array.isArray(entries) || entries.length === 0 || entries.length > 100)
		throw new Error('targets must contain 1 to 100 project/notebook pairs');
	const seen = new Set();
	return entries.map((entry) => {
		if (
			!entry ||
			typeof entry !== 'object' ||
			Array.isArray(entry) ||
			Object.keys(entry).some((key) => !['project-id', 'notebook-id', 'name'].includes(key)) ||
			!['project-id', 'notebook-id'].every(
				(key) => typeof entry[key] === 'string' && entry[key].trim(),
			) ||
			(entry.name !== undefined && (typeof entry.name !== 'string' || !entry.name.trim()))
		)
			throw new Error('Each target requires project-id and notebook-id, with an optional name');
		const target = {
			project: entry['project-id'].trim(),
			notebook: entry['notebook-id'].trim(),
			name: entry.name?.trim(),
		};
		const key = JSON.stringify([target.project, target.notebook]);
		if (seen.has(key)) throw new Error('targets must not contain duplicate project/notebook pairs');
		seen.add(key);
		return target;
	});
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
		targets: targets(input),
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

function hash(value) {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function targetKey(config, target) {
	return hash([config.hub, target.project, target.notebook]);
}

function renderTarget(config, { target, result, error }) {
	const key = targetKey(config, target);
	const rows = [];
	const row = (preview, commit, status) =>
		rows.push(
			`| ${markdown(target.project)} | ${markdown(target.name ?? target.notebook)} | ${preview} | ${commit} | ${status} |`,
		);
	if (error) row('—', '—', 'Reconciliation failed. See workflow logs.');
	else if (result.state !== 'active') row('—', '—', 'retired');
	else {
		for (const item of result.items) {
			const url = new URL(item.url);
			if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid preview URL');
			const commit = item.target_commit ?? item.commit;
			row(
				`[${markdown(item.name)}](<${url.href.replaceAll('>', '%3E').replaceAll('|', '%7C')}>)`,
				commit ? markdown(commit.slice(0, 12)) : 'pending',
				markdown(item.preparation),
			);
		}
		if (result.pending) row('—', '—', 'waiting for project capacity');
		else if (rows.length === 0) row('—', '—', 'No previews are available yet.');
	}
	rows[0] = rows[0].replace('| ', `| <!-- marimohub-preview-target:${key} --> `);
	rows[rows.length - 1] = rows
		.at(-1)
		.replace(/ \|$/, ` <!-- /marimohub-preview-target:${key} --> |`);
	return rows.join('\n');
}

export function renderComment(config, results, previous = '') {
	const marker = `<!-- marimohub-previews:${hash(config.hub)} -->`;
	const rows = new Map();
	// Keep whole target blocks so commit retention replaces all rows for that notebook.
	for (const match of previous.matchAll(
		/^\| <!-- marimohub-preview-target:([a-f0-9]{64}) --> [\s\S]*?<!-- \/marimohub-preview-target:\1 --> \|$/gm,
	))
		rows.set(match[1], match[0]);
	for (const entry of results)
		rows.set(targetKey(config, entry.target), renderTarget(config, entry));
	return {
		marker,
		body: [
			marker,
			'### marimo notebook previews',
			'',
			'| Project | Notebook | Preview | Commit | Status |',
			'| --- | --- | --- | --- | --- |',
			...rows.values(),
			'',
			'Opening a deferred preview prepares its code. Compute starts when you open an app or editor.',
		].join('\n'),
	};
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
	// GitHub gives Dependabot pull_request runs no Actions secrets; a red check would block every such PR.
	if (!input('hub-token').trim()) {
		await summary('PR previews are skipped because hub-token is empty.\n');
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
		return response.status === 204 ? undefined : responseJson(response, 'GitHub');
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
	const results = [];
	const previews = [];
	const failures = [];
	for (const target of config.targets) {
		try {
			const response = await request(
				`${config.hub}/api/v1/projects/${encodeURIComponent(target.project)}/notebooks/${encodeURIComponent(target.notebook)}/previews/reconcile`,
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
			const entry = { target, result };
			renderTarget(config, entry);
			const items = result.items.map((item) => ({
				project_id: target.project,
				notebook_id: target.notebook,
				id: item.id,
				url: item.url,
				commit: item.target_commit ?? item.commit,
				preparation: item.preparation,
			}));
			results.push(entry);
			previews.push(...items);
		} catch (error) {
			warning(`Preview target ${target.project}/${target.notebook}: ${error.message}`);
			failures.push(error);
			results.push({ target, error: true });
		}
	}
	const comment = renderComment(config, results);
	await output('previews', JSON.stringify(previews));
	await output('preview-ids', JSON.stringify(previews.map((item) => item.id)));
	await output('preview-urls', JSON.stringify(previews.map((item) => item.url)));
	await output('commits', JSON.stringify(previews.map((item) => item.commit)));
	await summary(`${comment.body}\n`);
	try {
		const legacyMarkers = new Set(
			config.targets.map((target) => `<!-- marimohub-preview:${targetKey(config, target)} -->`),
		);
		const matching = [];
		for (let page = 1; ; page++) {
			const comments = await github(`/issues/${pr.number}/comments?per_page=100&page=${page}`);
			matching.push(
				...comments.filter(
					(item) =>
						item.user?.type === 'Bot' &&
						(item.body?.includes(comment.marker) ||
							[...legacyMarkers].some((marker) => item.body?.includes(marker))),
				),
			);
			if (comments.length < 100) break;
		}
		const existing = matching.find((item) => item.body.includes(comment.marker)) ?? matching[0];
		const merged = renderComment(config, results, matching.map((item) => item.body).join('\n'));
		if (merged.body.length > 60_000) throw new Error('Preview comment exceeds the size limit');
		if (existing) await github(`/issues/comments/${existing.id}`, 'PATCH', { body: merged.body });
		else await github(`/issues/${pr.number}/comments`, 'POST', { body: merged.body });
		for (const duplicate of matching) {
			if (duplicate.id !== existing?.id) await github(`/issues/comments/${duplicate.id}`, 'DELETE');
		}
	} catch {
		warning(
			'Preview results could not be written to the PR comment. Check pull-requests: write and comment size. Results are in the workflow summary.',
		);
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1)
		throw new Error(
			`Hub preview reconciliation failed for ${failures.length} targets. Check the notebook grants and GitHub App connections.`,
		);
}
