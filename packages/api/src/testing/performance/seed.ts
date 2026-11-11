import {
	CatalogService,
	NotebookId,
	ProjectId,
	SessionId,
	SandboxId,
	createServices,
	paths,
} from '@marimo-hub/core';
import type { Project, Session, SnapshotProjectEntry, UserId } from '@marimo-hub/core';
import { ACTOR, uid } from '@marimo-hub/core/testing';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';

export const OWNER = ACTOR;
export const ALICE = uid('user_alice');
export const USERS = {
	alice: ALICE,
	bob: uid('user_bob'),
	carol: uid('user_carol'),
	dave: uid('user_dave'),
	erin: uid('user_erin'),
};

type Role = 'admin' | 'editor' | 'viewer' | 'app-user';

/** Rotating memberships: alice is editor/viewer/app-user/absent on a 4-project cycle. */
function membersFor(i: number): { user_id: UserId; role: Role }[] {
	const members: { user_id: UserId; role: Role }[] = [{ user_id: OWNER, role: 'admin' }];
	const alice = (['editor', 'viewer', 'app-user', null] as const)[i % 4];
	if (alice) members.push({ user_id: USERS.alice, role: alice });
	if (i % 2 === 0) members.push({ user_id: USERS.bob, role: 'editor' });
	if (i % 3 === 0) members.push({ user_id: USERS.carol, role: 'viewer' });
	if (i % 5 === 0) members.push({ user_id: USERS.dave, role: 'admin' });
	members.push({ user_id: USERS.erin, role: 'app-user' });
	return members;
}

export interface Seeded {
	bucket: MemoryBucket;
	projects: { id: ProjectId; notebooks: NotebookId[] }[];
	/** The requester is an editor in this project. */
	pid: ProjectId;
	nid: NotebookId;
	/** Second notebook in `pid` used for saves (no live editor). */
	saveNid: NotebookId;
}

const CODE = (j: number) =>
	`import marimo\n\napp = marimo.App()\n\n@app.cell\ndef _():\n    x = ${j}\n    return (x,)\n\nif __name__ == "__main__":\n    app.run()\n`;

/**
 * Clone a service-created template to avoid 10,000 catalog rewrites during setup.
 * Stable IDs preserve search tie-breaks and LIST pagination across test runs.
 */
export async function seed(
	P: number,
	M: number,
	opts: { terminalSessions: number },
): Promise<Seeded> {
	const bucket = new MemoryBucket();
	const catalog = new CatalogService(bucket);
	await catalog.initialize(OWNER);
	const services = createServices(bucket);
	const tpl = await services.projects.createProject(
		{ name: 'Template', description: 'Benchmark project', tags: ['team/data'] },
		OWNER,
	);
	const tplNotebooks: NotebookId[] = [];
	for (let j = 0; j < M; j++) {
		const nb = await services.notebooks.createNotebook(
			tpl.id,
			{
				title: `Notebook ${j} quarterly revenue analysis`,
				description: 'A moderately descriptive notebook description used for benchmarking.',
				code: CODE(j),
				tags: ['analytics'],
			},
			OWNER,
		);
		tplNotebooks.push(nb.id);
	}
	const prefix = `projects/${tpl.id}/`;
	const listed = await bucket.list({ prefix, limit: 10000 });
	const tplObjects = await Promise.all(
		listed.objects.map(async (o) => ({
			key: o.key,
			body: await (await bucket.get(o.key))!.text(),
		})),
	);
	const tplEntry = (await catalog.getCurrentSnapshot()).projects.find((p) => p.id === tpl.id)!;
	const idPattern = new RegExp([tpl.id, ...tplNotebooks].join('|'), 'g');

	const projects: Seeded['projects'] = [];
	const entries: SnapshotProjectEntry[] = [];
	for (let i = 0; i < P; i++) {
		const pid = ProjectId.parse(`proj-${String(i).padStart(16, '0')}`);
		const nids = tplNotebooks.map((_, j) =>
			NotebookId.parse(`nb-${String(i * M + j).padStart(16, '0')}`),
		);
		const map = new Map<string, string>([[tpl.id, pid]]);
		tplNotebooks.forEach((n, j) => map.set(n, nids[j]));
		const rewrite = (s: string) => s.replace(idPattern, (m) => map.get(m)!);
		const members = membersFor(i);
		const name = `Project ${i} team workspace`;
		for (const obj of tplObjects) {
			const key = rewrite(obj.key);
			let body = rewrite(obj.body);
			if (obj.key === paths.project(tpl.id).meta) {
				body = JSON.stringify({ ...(JSON.parse(body) as Project), name, members });
			}
			await bucket.put(key, body);
		}
		const entry = JSON.parse(rewrite(JSON.stringify(tplEntry))) as SnapshotProjectEntry;
		entries.push({ ...entry, access: undefined, name, member_ids: members.map((m) => m.user_id) });
		projects.push({ id: pid, notebooks: nids });
	}
	await catalog.mutateSnapshot('bench.seed', OWNER, (snap) => ({ ...snap, projects: entries }));
	for (const obj of tplObjects) await bucket.delete(obj.key);

	// Sessions: a few live ones, plus `terminalSessions` reclaimed terminal records from the
	// last 24h; 10% sit in the target project, the rest spread round-robin.
	const now = Date.now();
	const users = Object.values(USERS);
	const put = (s: Session) =>
		bucket.put(paths.session(s.project_id, s.session_id), JSON.stringify(s));
	let otherProject = 0;
	for (let k = 0; k < opts.terminalSessions; k++) {
		const project =
			k % 10 === 0 || projects.length === 1
				? projects[0]
				: projects[1 + (otherProject++ % (projects.length - 1))];
		const started = new Date(now - ((k * 43_000) % 82_800_000) - 3_600_000).toISOString();
		await put({
			session_id: SessionId.parse(`sess-${String(k).padStart(16, '0')}`),
			project_id: project.id,
			notebook_id: project.notebooks[k % project.notebooks.length],
			user_id: users[k % users.length],
			status: k % 7 === 0 ? 'failed' : 'terminated',
			mode: 'edit',
			started_at: started,
			last_heartbeat: started,
			sandbox_id: SandboxId.parse(`sb-${String(k).padStart(16, '0')}`),
			sandbox_reclaimed_at: started,
		});
	}
	const heartbeat = new Date(now - 10_000).toISOString();
	const live = [
		{ p: 0, n: 5, user: USERS.bob },
		{ p: 0, n: 6, user: USERS.dave },
		{ p: 0, n: 7, user: OWNER },
		{ p: Math.min(4, P - 1), n: 1, user: USERS.alice },
		{ p: Math.min(8, P - 1), n: 2, user: USERS.alice },
	];
	for (const [i, { p, n, user }] of live.entries()) {
		const project = projects[p];
		await put({
			session_id: SessionId.parse(`sess-${String(opts.terminalSessions + i).padStart(16, '0')}`),
			project_id: project.id,
			notebook_id: project.notebooks[n % project.notebooks.length],
			user_id: user,
			status: 'running',
			mode: 'edit',
			started_at: heartbeat,
			last_heartbeat: heartbeat,
			expires_at: new Date(now + 3_600_000).toISOString(),
			sandbox_id: SandboxId.parse(`sb-${String(opts.terminalSessions + i).padStart(16, '0')}`),
		});
	}

	return {
		bucket,
		projects,
		pid: projects[0].id,
		nid: projects[0].notebooks[0],
		saveNid: projects[0].notebooks[1],
	};
}
