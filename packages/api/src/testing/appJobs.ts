import { ProxyExposure, signProxyToken, verifyAppJobCredential } from '@marimo-hub/core';
import type { AppVisit, SessionId, UserId } from '@marimo-hub/core';
import { ACTOR, uid } from '@marimo-hub/core/testing';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { APP_JOBS_PATH } from '../jobs/appJobsEndpoint';
import { authorizeProxyRequest } from '../sandboxProxy';
import { createAppSessionFixture } from './appSession';
import { createTestApi, expectOk } from './index';

export const APP_JOBS_TEST_ENDPOINT = `http://hub.test${APP_JOBS_PATH}`;

export async function createAppJobsFixture(user = uid('app-consumer')) {
	const f = await createAppSessionFixture(new MemoryBucket());
	const exposure = f.client.deps.sandbox.exposure;
	if (!(exposure instanceof ProxyExposure)) throw new Error('Expected proxy exposure');
	const secret = exposure.signingSecret;
	const path = `/projects/${f.project.id}/notebooks/${f.notebook.id}/sessions`;
	const job = await f.services.jobs.createJob(
		f.project.id,
		f.notebook.id,
		{ name: 'consumer', consumer_execution: true },
		ACTOR,
	);

	async function visitAs(visitor: UserId, visitId = visitor === ACTOR ? 'tab' : visitor) {
		if (visitor !== ACTOR)
			await f.services.projects.addMember(f.project.id, { user_id: visitor }, 'app-user', ACTOR);
		const client = createTestApi({
			bucket: f.bucket,
			deps: {
				...f.client.deps,
				policy: { ...f.client.deps.policy, defaultRole: undefined },
				authenticator: {
					authenticate: async () => ({
						id: visitor,
						email: `${visitor}@example.com`,
						credential: { kind: 'development' },
					}),
				},
			},
		});
		const visit = await expectOk<{ session_id: SessionId; app_assignment: AppVisit }>(
			await client.request('POST', path, { mode: 'app', app_visit_id: visitId }),
		);
		const routing = await signProxyToken(f.project.id, visit.session_id, secret);
		const decision = await authorizeProxyRequest(
			new Request(`http://hub.test/proxy/${routing}/`, {
				headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
			}),
			client.deps,
		);
		if (decision.kind !== 'forward' || !decision.appJobCredential)
			throw new Error('Missing app credential');
		const credential = decision.appJobCredential;
		const claims = await verifyAppJobCredential(credential, secret, APP_JOBS_TEST_ENDPOINT);
		if (!claims) throw new Error('Invalid app credential');
		const call = async (
			operation: string,
			body: unknown = { job_id: job.id },
			token: string | null = credential,
		) =>
			client.app.request(`${APP_JOBS_TEST_ENDPOINT}/${operation}`, {
				method: 'POST',
				headers: {
					...(token === null ? {} : { authorization: `Bearer ${token}` }),
					'content-type': 'application/json',
				},
				body: typeof body === 'string' ? body : JSON.stringify(body),
			});
		const leave = () =>
			client.request('POST', `${path}/${visit.session_id}/leave`, visit.app_assignment);
		return { client, user: visitor, visit, credential, claims, call, leave };
	}
	return { ...f, ...(await visitAs(user)), secret, job, visitAs };
}
