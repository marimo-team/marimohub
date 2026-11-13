import { describe, it, expect, vi } from 'vitest';
import { SourceControlAccountService } from './SourceControlAccountService';
import { AesGcmSecretCodec } from '../secrets/AesGcmSecretCodec';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { UserId } from '../../ids';
import type {
	SourceControlAccountProvider,
	SourceControlUserTokens,
} from '../../ports/sourceControlAccount';

const uid = UserId.parse('user-alice');
function fixture() {
	let time = 100_000;
	const bucket = new MemoryBucket();
	const codec = new AesGcmSecretCodec({
		kek: '0123456789abcdef1032547698badcfeffeeddccbbaa99887766554433221100',
	});
	const tokens = (overrides: Partial<SourceControlUserTokens> = {}) => ({
		accessToken: 'access-secret',
		refreshToken: 'refresh-secret',
		expiresAt: time + 3600_000,
		refreshExpiresAt: time + 86400_000,
		...overrides,
	});
	const provider: SourceControlAccountProvider = {
		provider: 'github',
		origin: 'https://github.com',
		clientId: 'test-app',
		authorizationUrl: (input) =>
			`https://github.com/login/oauth/authorize?${new URLSearchParams(input)}`,
		exchange: vi.fn(async () => tokens()),
		refresh: vi.fn(async () => tokens()),
		identity: vi.fn(async () => ({ id: '123', login: 'alice' })),
		revoke: vi.fn(async () => {}),
	};
	const createService = (accountProvider = provider) =>
		new SourceControlAccountService(
			bucket,
			codec,
			accountProvider,
			'https://hub.example/api/v1/me/github/callback',
			() => time,
		);
	const service = createService();
	const begin = async () => new URL(await service.begin(uid, 'browser')).searchParams.get('state')!;
	const link = async () => {
		await service.complete(uid, 'browser', await begin(), 'code');
		return service.reference(uid);
	};
	return {
		bucket,
		codec,
		provider,
		service,
		createService,
		tokens,
		begin,
		link,
		advance: (ms: number) => {
			time += ms;
		},
	};
}

describe('SourceControlAccountService', () => {
	it('encrypts tokens and binds a connection to its owner', async () => {
		const { service, link, bucket } = fixture();
		const ref = await link();
		expect(await service.accessToken(uid, ref)).toBe('access-secret');
		expect(await service.status(UserId.parse('user-bob'))).toBeNull();
		await expect(service.accessToken(UserId.parse('user-bob'), ref)).rejects.toThrow('Connect');
		for (const item of (await bucket.list()).objects) {
			const text = await (await bucket.get(item.key))!.text();
			expect(text).not.toContain('access-secret');
			expect(text).not.toContain('refresh-secret');
		}
	});
	it('rejects wrong browser and consumes state once across service instances', async () => {
		const { service, begin, provider, createService } = fixture();
		const state = await begin();
		await expect(service.complete(uid, 'other', state, 'code')).rejects.toThrow('browser');
		await service.complete(uid, 'browser', state, 'code');
		const other = createService();
		await expect(other.complete(uid, 'browser', state, 'code')).rejects.toThrow('browser');
		expect(provider.exchange).toHaveBeenCalledOnce();
	});
	it('rejects expired and changed-App authorization attempts', async () => {
		const f = fixture();
		const state = await f.begin();
		f.advance(601_000);
		await expect(f.service.complete(uid, 'browser', state, 'code')).rejects.toThrow('expired');
		const next = await f.begin();
		const changed = f.createService({ ...f.provider, clientId: 'other' });
		await expect(changed.complete(uid, 'browser', next, 'code')).rejects.toThrow('expired');
		expect(f.provider.exchange).not.toHaveBeenCalled();
	});
	it('retains account identity through refresh and fences disconnect/relink', async () => {
		const f = fixture();
		const ref = await f.link();
		f.advance(3600_000);
		expect(await f.service.accessToken(uid, ref)).toBe('access-secret');
		expect(f.provider.refresh).toHaveBeenCalledOnce();
		expect(await f.service.reference(uid)).toEqual(ref);
		await f.service.disconnect(uid);
		const next = await f.link();
		expect(next.connectionId).not.toBe(ref.connectionId);
		await expect(f.service.accessToken(uid, ref)).rejects.toThrow('no longer connected');
	});
	it('never retries an uncertain rotating refresh', async () => {
		const f = fixture();
		const ref = await f.link();
		f.advance(3600_000);
		vi.mocked(f.provider.refresh).mockRejectedValue(new Error('provider response with secrets'));
		await expect(f.service.accessToken(uid, ref)).rejects.toThrow('could not be confirmed');
		await expect(f.service.accessToken(uid, ref)).rejects.toThrow('refreshing');
		expect(f.provider.refresh).toHaveBeenCalledOnce();
		expect(await f.service.status(uid)).toMatchObject({ connected: false });
	});
	it('does not restore a disconnected account after a late token exchange', async () => {
		const f = fixture();
		const gate = Promise.withResolvers<void>();
		const exchange = f.provider.exchange;
		f.provider.exchange = vi.fn(async (input) => {
			await gate.promise;
			return exchange(input);
		});
		const complete = f.service.complete(uid, 'browser', await f.begin(), 'code');
		await vi.waitFor(() => expect(f.provider.exchange).toHaveBeenCalled());
		await f.service.disconnect(uid);
		gate.resolve();
		await expect(complete).rejects.toThrow('Disconnect');
		expect(await f.service.status(uid)).toBeNull();
	});
	it('uses a persistent attempt budget across replicas', async () => {
		const f = fixture();
		for (let i = 0; i < 10; i++) await f.begin();
		await expect(f.begin()).rejects.toThrow('Too many');
	});
});

it('accepts references with reordered fields and extra actor metadata', async () => {
	const f = fixture();
	const ref = await f.link();
	expect(
		await f.service.accessToken(uid, {
			accountId: ref.accountId,
			kind: 'user',
			generation: ref.generation,
			connectionId: ref.connectionId,
		} as typeof ref),
	).toBe('access-secret');
});
it('consumes concurrent callbacks once', async () => {
	const f = fixture();
	const state = await f.begin();
	const results = await Promise.allSettled([
		f.service.complete(uid, 'browser', state, 'code'),
		f.service.complete(uid, 'browser', state, 'code'),
	]);
	expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
	expect(f.provider.exchange).toHaveBeenCalledOnce();
});
it('does not resurrect a connection when disconnect races a rotating refresh', async () => {
	const f = fixture();
	const ref = await f.link();
	f.advance(3600_000);
	const gate = Promise.withResolvers<void>();
	const refresh = f.provider.refresh;
	f.provider.refresh = vi.fn(async (token) => {
		await gate.promise;
		return refresh(token);
	});
	const access = f.service.accessToken(uid, ref);
	await vi.waitFor(() => expect(f.provider.refresh).toHaveBeenCalled());
	await expect(f.service.accessToken(uid, ref)).rejects.toThrow('refreshing');
	expect(await f.service.disconnect(uid)).toEqual({ remote_revocation_confirmed: false });
	gate.resolve();
	await expect(access).rejects.toThrow('could not be confirmed');
	expect(await f.service.status(uid)).toBeNull();
});
it('clears local credentials after the configured App changes and reports uncertain revocation', async () => {
	const f = fixture();
	const ref = await f.link();
	const changed = f.createService({ ...f.provider, clientId: 'other' });
	expect(await changed.disconnect(uid)).toEqual({ remote_revocation_confirmed: false });
	expect(await changed.status(uid)).toBeNull();
	expect(f.provider.revoke).not.toHaveBeenCalled();
	const raw = await (await f.bucket.get(
		`_system/source-control-accounts/${uid}/${ref.connectionId}.json`,
	))!.json();
	expect(raw).not.toHaveProperty('tokens');
});
it('reconciles a successful head CAS whose response was lost', async () => {
	const f = fixture();
	const state = await f.begin();
	const put = f.bucket.put.bind(f.bucket);
	vi.spyOn(f.bucket, 'put').mockImplementation(async (key, value, options) => {
		const result = await put(key, value, options);
		if (
			key.endsWith('head.json') &&
			(JSON.parse(String(value)) as { connection?: string }).connection
		)
			throw new Error('lost response');
		return result;
	});
	await f.service.complete(uid, 'browser', state, 'code');
	expect(await f.service.status(uid)).toMatchObject({ connected: true });
	expect(f.provider.revoke).not.toHaveBeenCalled();
});
it('removes orphan credentials after the publication deadline without touching the winning account', async () => {
	const f = fixture();
	await f.link();
	await expect(f.service.complete(uid, 'browser', await f.begin(), 'code')).rejects.toThrow(
		'Disconnect',
	);
	f.advance(16 * 60_000);
	await f.service.sweep();
	expect(await f.service.status(uid)).toMatchObject({ connected: true });
	expect(f.provider.revoke).toHaveBeenCalledOnce();
	const records = await Promise.all(
		(await f.bucket.list({ prefix: `_system/source-control-accounts/${uid}/` })).objects
			.filter((item) => !item.key.endsWith('head.json'))
			.map(async (item) => (await f.bucket.get(item.key))!.json<Record<string, unknown>>()),
	);
	expect(records.filter((r) => r.tokens)).toHaveLength(1);
});

it.each(['identity', 'storage'])(
	'revokes an issued token if %s fails before account publication',
	async (stage) => {
		const f = fixture();
		const state = await f.begin();
		if (stage === 'identity')
			vi.mocked(f.provider.identity).mockRejectedValue(new Error('identity unavailable'));
		else {
			const put = f.bucket.put.bind(f.bucket);
			vi.spyOn(f.bucket, 'put').mockImplementation((key, value, options) => {
				if (key.startsWith('_system/source-control-accounts/') && !key.endsWith('head.json'))
					throw new Error('storage unavailable');
				return put(key, value, options);
			});
		}
		await expect(f.service.complete(uid, 'browser', state, 'code')).rejects.toThrow('unavailable');
		expect(f.provider.revoke).toHaveBeenCalledWith('access-secret');
		expect(await f.service.status(uid)).toBeNull();
	},
);

describe('credential failure recovery', () => {
	it('allows only one replica to rotate a token and lets the loser retry the stored pair', async () => {
		const f = fixture();
		const ref = await f.link();
		f.advance(3600_000);
		const gate = Promise.withResolvers<void>();
		vi.mocked(f.provider.refresh).mockImplementation(async () => {
			await gate.promise;
			return f.tokens({ accessToken: 'rotated-access', refreshToken: 'rotated-refresh' });
		});
		const replica = f.createService();
		const first = f.service.accessToken(uid, ref);
		try {
			await vi.waitFor(() => expect(f.provider.refresh).toHaveBeenCalledOnce());
			await expect(replica.accessToken(uid, ref)).rejects.toThrow('refreshing');
		} finally {
			gate.resolve();
		}
		expect(await first).toBe('rotated-access');
		expect(await replica.accessToken(uid, ref)).toBe('rotated-access');
		expect(f.provider.refresh).toHaveBeenCalledExactlyOnceWith('refresh-secret');
		expect(await replica.reference(uid)).toEqual(ref);
	});

	it.each(['before write', 'after write'] as const)(
		'handles a lost refresh persistence response %s',
		async (failure) => {
			const f = fixture();
			const ref = await f.link();
			f.advance(3600_000);
			vi.mocked(f.provider.refresh).mockResolvedValue(
				f.tokens({ accessToken: 'rotated-access', refreshToken: 'rotated-refresh' }),
			);
			const key = `_system/source-control-accounts/${uid}/${ref.connectionId}.json`;
			const put = f.bucket.put.bind(f.bucket);
			vi.spyOn(f.bucket, 'put').mockImplementation(async (path, value, options) => {
				if (
					path === key &&
					!(JSON.parse(String(value)) as { refreshClaim?: string }).refreshClaim
				) {
					if (failure === 'after write') await put(path, value, options);
					throw new Error('lost storage response');
				}
				return put(path, value, options);
			});
			if (failure === 'after write') {
				expect(await f.service.accessToken(uid, ref)).toBe('rotated-access');
				expect(await f.service.accessToken(uid, ref)).toBe('rotated-access');
			} else {
				await expect(f.service.accessToken(uid, ref)).rejects.toThrow('could not be confirmed');
				f.advance(60_001);
				await expect(f.service.accessToken(uid, ref)).rejects.toThrow('interrupted');
			}
			expect(f.provider.refresh).toHaveBeenCalledOnce();
			expect(f.provider.revoke).not.toHaveBeenCalled();
		},
	);

	it('rejects expired refresh credentials without contacting the provider', async () => {
		const f = fixture();
		const ref = await f.link();
		f.advance(86400_000);
		vi.mocked(f.provider.identity).mockClear();
		await expect(f.service.accessToken(uid, ref)).rejects.toThrow('Reconnect');
		expect(f.provider.refresh).not.toHaveBeenCalled();
		expect(f.provider.identity).not.toHaveBeenCalled();
	});

	it('rejects an account identity change even when the token is still valid', async () => {
		const f = fixture();
		const ref = await f.link();
		vi.mocked(f.provider.identity).mockResolvedValue({ id: '999', login: 'other' });
		await expect(f.service.accessToken(uid, ref)).rejects.toThrow('identity changed');
		expect(f.provider.refresh).not.toHaveBeenCalled();
		expect(await f.service.reference(uid)).toEqual(ref);
	});

	it.each(['provider failure', 'unreadable ciphertext'] as const)(
		'disconnects locally despite %s',
		async (failure) => {
			const f = fixture();
			const ref = await f.link();
			if (failure === 'provider failure')
				vi.mocked(f.provider.revoke).mockRejectedValue(new Error('provider down'));
			else vi.spyOn(f.codec, 'decrypt').mockRejectedValue(new Error('key unavailable'));
			expect(await f.service.disconnect(uid)).toEqual({ remote_revocation_confirmed: false });
			await expect(f.service.accessToken(uid, ref)).rejects.toThrow('Connect');
			expect(await f.service.status(uid)).toBeNull();
			const stored = await (await f.bucket.get(
				`_system/source-control-accounts/${uid}/${ref.connectionId}.json`,
			))!.json();
			expect(stored).not.toHaveProperty('tokens');
			expect(stored).not.toHaveProperty('refreshClaim');
		},
	);

	it('does not release a credential when disconnect happens during identity revalidation', async () => {
		const f = fixture();
		const ref = await f.link();
		const gate = Promise.withResolvers<void>();
		vi.mocked(f.provider.identity).mockImplementationOnce(async () => {
			await gate.promise;
			return { id: '123', login: 'alice' };
		});
		vi.mocked(f.provider.identity).mockClear();
		const access = f.service.accessToken(uid, ref);
		const rejected = expect(access).rejects.toThrow('Connect');
		try {
			await vi.waitFor(() => expect(f.provider.identity).toHaveBeenCalledOnce());
			await f.service.disconnect(uid);
		} finally {
			gate.resolve();
		}
		await rejected;
	});

	it('restarts a corrupt cleanup cursor and expires pending OAuth state', async () => {
		const f = fixture();
		const state = await f.begin();
		f.advance(16 * 60_000);
		await f.bucket.put('_system/source-control-account-cleanup.json', '{broken');
		await f.service.sweep();
		const head = await (await f.bucket.get(
			`_system/source-control-accounts/${uid}/head.json`,
		))!.json();
		expect(head).not.toHaveProperty('attempt');
		expect(head).toMatchObject({ attempts: [], callbacks: [] });
		await expect(f.service.complete(uid, 'browser', state, 'code')).rejects.toThrow('expired');
		expect(f.provider.exchange).not.toHaveBeenCalled();
	});
});

it('fences a stalled callback before orphan cleanup revokes its credentials', async () => {
	const f = fixture();
	const state = await f.begin();
	const saved = Promise.withResolvers<string>();
	const resume = Promise.withResolvers<void>();
	const put = f.bucket.put.bind(f.bucket);
	vi.spyOn(f.bucket, 'put').mockImplementation(async (key, value, options) => {
		const result = await put(key, value, options);
		if (key.startsWith(`_system/source-control-accounts/${uid}/`) && options?.onlyIfNotExists) {
			saved.resolve(key);
			await resume.promise;
		}
		return result;
	});
	const callback = f.service.complete(uid, 'browser', state, 'code');
	const rejected = expect(callback).rejects.toThrow('Disconnect');
	const key = await saved.promise;
	try {
		await f.service.sweep();
		expect(f.provider.revoke).not.toHaveBeenCalled();
		f.advance(16 * 60_000);
		await f.service.sweep();
		expect(f.provider.revoke).toHaveBeenCalledExactlyOnceWith('access-secret');
		expect(await (await f.bucket.get(key))!.json()).not.toHaveProperty('tokens');
	} finally {
		resume.resolve();
	}
	await rejected;
	expect(await f.service.status(uid)).toBeNull();
});
