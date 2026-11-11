import { describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '../../errors';
import { createSandboxId } from '../../ids';
import { fakeComputeFrom, makeFakeSandbox, makeSession } from '../../testing';
import { reconnectSessionSandbox, sessionSandbox } from './sessionSandbox';

function setup(reference?: string) {
	const { instance } = makeFakeSandbox();
	const provider = fakeComputeFrom(instance);
	const create = vi.spyOn(provider, 'create');
	const connect = vi.spyOn(provider, 'connectExisting');
	const session = makeSession({ sandbox_id: createSandboxId(), reconnect_reference: reference });
	return { instance, provider, create, connect, session };
}

describe('sessionSandbox', () => {
	it('attributes reconnect attempts without leaking references and tolerates metric failures', () => {
		const { provider, session, instance } = setup('private-reference');
		const metrics = { increment: vi.fn(), gauge: vi.fn() };
		expect(sessionSandbox(provider, session, metrics, 'poll')).toBe(instance);
		expect(metrics.increment).toHaveBeenCalledExactlyOnceWith('sandbox.reconnect', 1, {
			path: 'poll',
			method: 'reference',
		});
		metrics.increment.mockImplementation(() => {
			throw new Error('metrics down');
		});
		expect(sessionSandbox(provider, session, metrics, 'teardown')).toBe(instance);
	});
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

describe('reconnectSessionSandbox', () => {
	it.each([
		[undefined, 'lookup'],
		['saved-reference', 'reference'],
	])('attaches without creating (reference=%s)', (reference, method) => {
		const { instance, provider, create, connect, session } = setup(reference);
		const metrics = { increment: vi.fn(), gauge: vi.fn() };
		expect(reconnectSessionSandbox(provider, session, metrics, 'host')).toBe(instance);
		expect(connect).toHaveBeenCalledExactlyOnceWith(session.sandbox_id, {
			owner: { projectId: session.project_id, userId: session.user_id },
			reconnectReference: reference,
		});
		expect(create).not.toHaveBeenCalled();
		expect(metrics.increment).toHaveBeenCalledExactlyOnceWith('sandbox.reconnect', 1, {
			path: 'host',
			method,
		});
	});

	it('returns undefined without a metric when the provider cannot attach', () => {
		const { provider, create, session } = setup('reference');
		const metrics = { increment: vi.fn(), gauge: vi.fn() };
		expect(
			reconnectSessionSandbox({ ...provider, connectExisting: undefined }, session, metrics),
		).toBeUndefined();
		expect(create).not.toHaveBeenCalled();
		expect(metrics.increment).not.toHaveBeenCalled();
	});
});
