import { vi } from 'vitest';
import {
	APP_PRESENCE_PERSIST_INTERVAL_MS,
	CatalogService,
	ProxyExposure,
	createServices,
	paths,
	signProxyToken,
} from '@marimo-hub/core';
import type { AppVisit, SessionId } from '@marimo-hub/core';
import type { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import {
	ACTOR,
	localResourceSecurity,
	makeFakeCompute,
	makeSubjectContext,
} from '@marimo-hub/core/testing';
import { authorizeProxyRequest } from '../sandboxProxy';
import { createTestApi, expectOk } from './index';

const SECRET = 'app-performance-test-secret-at-least-32-bytes';

export async function createAppSessionFixture<T extends MemoryBucket>(bucket: T, labeled = false) {
	await new CatalogService(bucket).initialize(ACTOR);
	const services = createServices(bucket);
	const project = await services.projects.createProject(
		{ name: 'App tests', description: '' },
		ACTOR,
	);
	const notebook = await services.notebooks.createNotebook(
		project.id,
		{ title: 'App', description: '', code: 'original' },
		ACTOR,
	);
	const resourceSecurity = localResourceSecurity(['PUBLIC', 'SECRET'], makeSubjectContext());
	const newClient = () =>
		createTestApi({
			bucket,
			compute: makeFakeCompute(),
			deps: {
				resourceSecurity,
				sandbox: {
					bucket: { name: 'test', endpoint: '' },
					hostname: 'localhost',
					workdir: '/workspace',
					persistWorkspace: 'source',
					exposure: new ProxyExposure(SECRET),
				},
			},
		});
	const client = newClient();
	const path = `/projects/${project.id}/notebooks/${notebook.id}/sessions`;
	const admit = () => client.request('POST', path, { mode: 'app', app_visit_id: 'tab' });
	const admission = await expectOk<{ session_id: SessionId; app_assignment: AppVisit }>(
		await admit(),
	);
	const session = await services.sessions.getSession(project.id, admission.session_id);
	if (labeled)
		await services.projects.setSecurityLabels(
			project.id,
			{ classification: 'SECRET', compartments: [] },
			ACTOR,
		);
	const token = await signProxyToken(project.id, admission.session_id, SECRET);
	const heartbeat = async (api = client) =>
		api.request('POST', `${path}/${admission.session_id}/heartbeat`, admission.app_assignment);
	const proxy = (upgrade = false) =>
		authorizeProxyRequest(
			new Request(
				`http://hub.test/proxy/${token}/`,
				upgrade ? { headers: { Upgrade: 'websocket', Connection: 'Upgrade' } } : undefined,
			),
			client.deps,
		);
	return {
		bucket,
		services,
		project,
		notebook,
		client,
		newClient,
		session,
		admission,
		admit,
		heartbeat,
		proxy,
		resourceSecurity,
		poolKey: paths.appPool(project.id, notebook.id),
		sessionKey: paths.session(project.id, admission.session_id),
	};
}

export function makeHeartbeatDue() {
	const now = Date.now();
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(now + APP_PRESENCE_PERSIST_INTERVAL_MS + 1_000);
}
