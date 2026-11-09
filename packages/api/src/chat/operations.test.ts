import { describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { ACTOR, localResourceSecurity, makeSubjectContext } from '@marimo-hub/core/testing';
import type { AuthenticatedPrincipal, ProjectId } from '@marimo-hub/core';
import { NotFoundError } from '@marimo-hub/core/errors';
import { withRequestMemo } from '../requestMemo';
import { createInitializedBucket, createTestApi, expectOk } from '../testing';
import { chatAi, textStream } from '../testing/chat';
import { createConversation, executeTurn, getConversation } from './operations';

const principal: AuthenticatedPrincipal = {
	id: ACTOR,
	email: 'actor@example.com',
	credential: { kind: 'development' },
};

describe('executeTurn', () => {
	it.each([
		['revoked', null],
		['lowered', makeSubjectContext({ classification: 'UNCLASSIFIED' })],
	])('rejects the answer when clearance is %s during the turn', async (_name, revoked) => {
		const security = localResourceSecurity(['UNCLASSIFIED', 'SECRET'], makeSubjectContext());
		const resolve = vi.spyOn(security.subjectContext!, 'resolve');
		const model = new MockLanguageModelV3({
			modelId: 'configured-model',
			doStream: async () => {
				resolve.mockResolvedValue(revoked);
				return textStream('The secret answer');
			},
		});
		const api = createTestApi({
			bucket: await createInitializedBucket(),
			deps: { ...chatAi(model), resourceSecurity: security },
		});
		const { id } = await expectOk<{ id: ProjectId }>(
			await api.request('POST', '/projects', { name: 'Sales', description: 'd' }),
			201,
		);
		await api.deps.services.projects.setSecurityLabels(
			id,
			{ classification: 'SECRET', compartments: [] },
			ACTOR,
		);
		const deps = withRequestMemo(api.deps);
		const context = { deps, principal, pid: id };
		const { conversation } = await createConversation(context);

		await expect(
			executeTurn({ ...context, cid: conversation.id, content: 'hello' }),
		).rejects.toBeInstanceOf(NotFoundError);
		expect(model.doStreamCalls).toHaveLength(1);
		resolve.mockResolvedValue(makeSubjectContext());
		const saved = await getConversation({
			...context,
			deps: withRequestMemo(api.deps),
			cid: conversation.id,
		});
		expect(saved.conversation.last_error).toBeTruthy();
	});
});
