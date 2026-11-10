import { describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '../../errors';
import { createSandboxId } from '../../ids';
import { fakeComputeFrom, makeFakeSandbox, makeSession } from '../../testing';
import { sessionSandbox } from './sessionSandbox';

function setup(reference?: string) {
	const { instance } = makeFakeSandbox();
	const provider = fakeComputeFrom(instance);
	const create = vi.spyOn(provider, 'create');
	const connect = vi.spyOn(provider, 'connectExisting');
	const session = makeSession({ sandbox_id: createSandboxId(), reconnect_reference: reference });
	return { instance, provider, create, connect, session };
}

describe('sessionSandbox', () => {
	it.each([undefined, 'saved-reference'])(
		'preserves lookup for providers without attach support (reference=%s)',
		(reference) => {
			const { instance, provider, create, session } = setup(reference);
			expect(sessionSandbox({ ...provider, connectExisting: undefined }, session)).toBe(instance);
			expect(create).toHaveBeenCalledExactlyOnceWith(session.sandbox_id, {
				owner: { projectId: session.project_id, userId: session.user_id },
			});
		},
	);

	it('rejects a session without a sandbox before contacting the provider', () => {
		const { provider, create, connect, session } = setup();
		expect(() => sessionSandbox(provider, { ...session, sandbox_id: undefined })).toThrow(
			NotFoundError,
		);
		expect(create).not.toHaveBeenCalled();
		expect(connect).not.toHaveBeenCalled();
	});

	it('propagates a synchronous attach failure without creating a replacement', () => {
		const { provider, create, connect, session } = setup('reference');
		const failure = new Error('Provider unavailable');
		connect.mockImplementation(() => {
			throw failure;
		});
		expect(() => sessionSandbox(provider, session)).toThrow(failure);
		expect(create).not.toHaveBeenCalled();
	});

	it('does not create a replacement when a referenced sandbox is gone', async () => {
		const { instance, provider, create, session } = setup('gone');
		vi.spyOn(instance, 'exec').mockRejectedValue(new NotFoundError('Sandbox is gone'));
		await expect(sessionSandbox(provider, session).exec('true')).rejects.toBeInstanceOf(
			NotFoundError,
		);
		expect(create).not.toHaveBeenCalled();
	});
});
