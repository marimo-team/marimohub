import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ValidationError } from '../../errors';
import type { SecretEnvelope, SecretRef } from '../../ports/secrets';
import {
	findStraySecretBoxes,
	isKeepMarker,
	openConfig,
	REDACTED_SECRET,
	redactConfig,
	sealConfig,
	secretPaths,
	zSecret,
} from './secretFields';
import type { StoredSecretValue } from './secretFields';

const schema = z.object({
	host: z.string(),
	auth: z.discriminatedUnion('method', [
		z.object({ method: z.literal('none') }),
		z.object({ method: z.literal('basic'), user: z.string(), password: zSecret() }),
	]),
	ssl: z.boolean().default(true),
	secrets: z.array(z.object({ name: z.string(), value: zSecret() })).default([]),
});

const jsonSchema = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
const paths = secretPaths(jsonSchema);

/** Fake sealer that records wildcard encryption contexts. */
function fakeSeal(calls: string[] = []) {
	return {
		calls,
		encrypt: (plaintext: string, at: string): Promise<StoredSecretValue> => {
			calls.push(at);
			return Promise.resolve({
				$secret: {
					kind: 'managed' as const,
					envelope: { kek_id: 'k', alg: 'A256GCM', iv: 'iv', ciphertext: btoa(plaintext) },
				},
			});
		},
		reference: (ref: SecretRef): Promise<StoredSecretValue> =>
			Promise.resolve({ $secret: { kind: 'reference', ...ref } }),
	};
}

const fakeOpen = {
	decrypt: (envelope: SecretEnvelope): Promise<string> =>
		Promise.resolve(atob(envelope.ciphertext)),
	resolve: (ref: SecretRef): Promise<string> => Promise.resolve(`resolved:${ref.locator}`),
};

describe('secretPaths', () => {
	it('finds marks inside union branches and array items, deduped', () => {
		expect(paths.map((p) => p.join('.')).sort()).toEqual(['auth.password', 'secrets.*.value']);
	});

	it('finds marks inside intersection (allOf) branches', () => {
		const intersected = z.intersection(
			z.object({ host: z.string() }),
			z.object({ token: zSecret() }),
		);
		const json = z.toJSONSchema(intersected, { io: 'input' }) as Record<string, unknown>;
		// Premise: an intersection really does compile to `allOf`.
		expect(json.allOf).toBeDefined();
		expect(secretPaths(json).map((p) => p.join('.'))).toEqual(['token']);
	});

	it('seals a secret that only appears under an intersection', async () => {
		const intersected = z.intersection(
			z.object({ host: z.string() }),
			z.object({ token: zSecret() }),
		);
		const json = z.toJSONSchema(intersected, { io: 'input' }) as Record<string, unknown>;
		const stored = await sealConfig({
			schema: intersected,
			paths: secretPaths(json),
			authoring: { host: 'h', token: 't0ken' },
			seal: fakeSeal(),
		});
		expect(JSON.stringify(stored)).not.toContain('t0ken');
		expect(redactConfig(stored, secretPaths(json)).token).toEqual(REDACTED_SECRET);
	});
});

describe('sealConfig / openConfig / redactConfig', () => {
	const authoring = {
		host: 'db.internal',
		auth: { method: 'basic', user: 'admin', password: 'hunter2' },
		secrets: [
			{ name: 'A', value: 'aaa' },
			{ name: 'B', value: 'bbb' },
		],
	};

	const storedConfig = () => sealConfig({ schema, paths, authoring, seal: fakeSeal() });

	const referenceConfig = (names: string[]) => ({
		secrets: names.map((name) => ({
			name,
			value: { $secret: { kind: 'reference', backend: 'vault', locator: name } },
		})),
	});

	it('round-trips authoring → stored → resolved, applying defaults', async () => {
		const seal = fakeSeal();
		const stored = await sealConfig({ schema, paths, authoring, seal });
		expect(stored.ssl).toBe(true);
		expect(JSON.stringify(stored)).not.toContain('hunter2');
		// Context is the wildcard path, not the concrete index.
		expect(seal.calls.sort()).toEqual(['auth.password', 'secrets.*.value', 'secrets.*.value']);

		const resolved = await openConfig({ stored, paths, open: fakeOpen });
		expect(resolved).toMatchObject({
			auth: { method: 'basic', password: 'hunter2' },
			secrets: [
				{ name: 'A', value: 'aaa' },
				{ name: 'B', value: 'bbb' },
			],
		});
	});

	it('stores, exposes, and resolves external references without resolving on read', async () => {
		const authoringWithReference = structuredClone(authoring);
		authoringWithReference.auth.password = {
			$secret: { kind: 'reference', backend: 'vault', locator: 'teams/data#password' },
		} as never;
		const stored = await sealConfig({
			schema,
			paths,
			authoring: authoringWithReference,
			seal: fakeSeal(),
		});
		expect((stored.auth as { password: unknown }).password).toEqual({
			$secret: { kind: 'reference', backend: 'vault', locator: 'teams/data#password' },
		});
		expect((redactConfig(stored, paths).auth as { password: unknown }).password).toEqual({
			$secret: { kind: 'reference', backend: 'vault', locator: 'teams/data#password' },
		});
		const opened = await openConfig({ stored, paths, open: fakeOpen });
		expect((opened.auth as { password: unknown }).password).toBe('resolved:teams/data#password');
	});

	it('resolves reference fields concurrently and preserves their slots', async () => {
		const stored = referenceConfig(['A', 'B', 'C']);
		const original = structuredClone(stored);
		const releases: (() => void)[] = [];
		let inFlight = 0;
		const opened = openConfig({
			stored,
			paths,
			open: {
				...fakeOpen,
				resolve(ref, at) {
					inFlight++;
					expect(at).toBe('secrets.*.value');
					return new Promise<string>((resolve) => {
						releases.push(() => resolve(`resolved:${ref.locator}`));
					});
				},
			},
		});
		await Promise.resolve();
		expect(inFlight).toBe(3);
		for (const release of releases.reverse()) release();
		await expect(opened).resolves.toEqual({
			secrets: ['A', 'B', 'C'].map((name) => ({ name, value: `resolved:${name}` })),
		});
		expect(stored).toEqual(original);
	});

	it('bounds secret lookups and refills each slot without waiting for its siblings', async () => {
		const names = Array.from({ length: 20 }, (_, i) => String(i));
		const stored = referenceConfig(names);
		const original = structuredClone(stored);
		const pending = names.map(() => Promise.withResolvers<string>());
		const started = names.map(() => Promise.withResolvers<void>());
		let inFlight = 0;
		let peak = 0;
		const resolve = vi.fn(async (ref: SecretRef) => {
			const index = Number(ref.locator);
			peak = Math.max(peak, ++inFlight);
			started[index].resolve();
			try {
				return await pending[index].promise;
			} finally {
				inFlight--;
			}
		});
		const opened = openConfig({ stored, paths, open: { ...fakeOpen, resolve } });

		await started[7].promise;
		expect(resolve).toHaveBeenCalledTimes(8);
		expect(inFlight).toBe(8);
		pending[7].resolve('resolved:7');
		await started[8].promise;
		expect(resolve).toHaveBeenCalledTimes(9);
		expect(inFlight).toBe(8);
		for (let i = pending.length - 1; i >= 0; i--) pending[i].resolve(`resolved:${i}`);

		await expect(opened).resolves.toEqual({
			secrets: names.map((name) => ({ name, value: `resolved:${name}` })),
		});
		expect(peak).toBe(8);
		expect(inFlight).toBe(0);
		expect(stored).toEqual(original);
	});

	it('releases failed lookup slots and observes failures from queued work', async () => {
		const names = Array.from({ length: 10 }, (_, i) => String(i));
		const stored = referenceConfig(names);
		const original = structuredClone(stored);
		const pending = names.map(() => Promise.withResolvers<string>());
		const started = names.map(() => Promise.withResolvers<void>());
		const resolve = vi.fn((ref: SecretRef) => {
			const index = Number(ref.locator);
			started[index].resolve();
			return pending[index].promise;
		});
		const opened = openConfig({ stored, paths, open: { ...fakeOpen, resolve } });
		const error = new Error('secret backend unavailable');
		const rejected = expect(opened).rejects.toBe(error);

		await started[7].promise;
		pending[0].reject(error);
		await rejected;
		await started[8].promise;
		expect(resolve).toHaveBeenCalledTimes(9);
		pending[8].reject(new Error('queued lookup failed'));
		await started[9].promise;
		expect(resolve).toHaveBeenCalledTimes(10);
		pending[9].reject(new Error('another queued lookup failed'));
		for (let i = 1; i < 8; i++) pending[i].resolve(`resolved:${i}`);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(stored).toEqual(original);
	});

	it.each(['throw', 'reject'] as const)(
		'preserves stored values when a resolver fails with %s',
		async (failure) => {
			const stored = await storedConfig();
			const original = structuredClone(stored);
			const error = new Error('secret backend unavailable');
			const decrypt = vi.fn((envelope: SecretEnvelope, at: string) => {
				if (at === 'auth.password') {
					if (failure === 'throw') throw error;
					return Promise.reject(error);
				}
				return fakeOpen.decrypt(envelope);
			});

			await expect(openConfig({ stored, paths, open: { ...fakeOpen, decrypt } })).rejects.toBe(
				error,
			);
			expect(decrypt).toHaveBeenCalledTimes(3);
			expect(stored).toEqual(original);
		},
	);

	it('observes sibling rejections after one concurrent resolution fails', async () => {
		const stored = await storedConfig();
		const pending = Array.from({ length: 3 }, () => Promise.withResolvers<string>());
		let index = 0;
		const opened = openConfig({
			stored,
			paths,
			open: { ...fakeOpen, decrypt: () => pending[index++].promise },
		});
		const error = new Error('first failure');
		const rejected = expect(opened).rejects.toBe(error);
		await Promise.resolve();
		pending[1].reject(error);
		await rejected;
		pending[0].reject(new Error('later failure'));
		pending[2].reject(new Error('another later failure'));
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

	it('validates all stored slots before starting secret resolution', async () => {
		const stored = await storedConfig();
		(stored.secrets as Record<string, unknown>[])[1].value = { $secret: { kind: 'future' } };
		const decrypt = vi.fn(fakeOpen.decrypt);
		const resolve = vi.fn(fakeOpen.resolve);

		await expect(openConfig({ stored, paths, open: { decrypt, resolve } })).rejects.toThrow(
			'Secret field "secrets.1.value" holds an unsupported stored shape.',
		);
		expect(decrypt).not.toHaveBeenCalled();
		expect(resolve).not.toHaveBeenCalled();
	});

	it('redacts every managed secret without exposing its envelope', async () => {
		const stored = await storedConfig();
		const redacted = redactConfig(stored, paths);
		expect(redacted.auth).toEqual({ method: 'basic', user: 'admin', password: REDACTED_SECRET });
		expect((redacted.secrets as unknown[])[0]).toEqual({ name: 'A', value: REDACTED_SECRET });
		expect(isKeepMarker((redacted.auth as { password: unknown }).password)).toBe(true);
	});

	it('keep-markers reuse the stored value, matching array entries by name across a reorder', async () => {
		const previous = await storedConfig();
		const edited = {
			host: 'db.internal',
			auth: { method: 'basic', user: 'admin', password: { $secret: { set: true } } },
			// B moved and is kept; A is removed; C receives a new value.
			secrets: [
				{ name: 'B', value: { $secret: { set: true } } },
				{ name: 'C', value: 'ccc' },
			],
		};
		const stored = await sealConfig({
			schema,
			paths,
			authoring: edited,
			previous,
			seal: fakeSeal(),
		});
		const resolved = await openConfig({ stored, paths, open: fakeOpen });
		expect(resolved).toMatchObject({
			auth: { password: 'hunter2' },
			secrets: [
				{ name: 'B', value: 'bbb' },
				{ name: 'C', value: 'ccc' },
			],
		});
	});

	it('rejects a keep-marker with nothing to keep', async () => {
		const edited = {
			...authoring,
			auth: { method: 'basic', user: 'admin', password: { $secret: { set: true } } },
		};
		await expect(
			sealConfig({ schema, paths, authoring: edited, seal: fakeSeal() }),
		).rejects.toThrow(ValidationError);
	});

	it('does not let a managed keep-marker preserve an external reference', async () => {
		const previous = await sealConfig({
			schema,
			paths,
			authoring: {
				...authoring,
				auth: {
					method: 'basic',
					user: 'admin',
					password: {
						$secret: { kind: 'reference', backend: 'vault', locator: 'apps/prod#token' },
					},
				},
			},
			seal: fakeSeal(),
		});
		await expect(
			sealConfig({
				schema,
				paths,
				authoring: {
					...authoring,
					auth: { method: 'basic', user: 'admin', password: REDACTED_SECRET },
				},
				previous,
				seal: fakeSeal(),
			}),
		).rejects.toThrow(/no stored encrypted value to keep/);
		expect(isKeepMarker({ $secret: { kind: 'reference', set: true } })).toBe(false);
	});

	it('rejects a forged stored envelope submitted as authoring input', async () => {
		const forged = {
			...authoring,
			auth: {
				method: 'basic',
				user: 'admin',
				password: { $secret: { kind: 'managed', envelope: { ciphertext: 'x' } } },
			},
		};
		await expect(
			sealConfig({ schema, paths, authoring: forged, seal: fakeSeal() }),
		).rejects.toThrow(/must be an encrypted value, an external reference, or a keep marker/);
	});

	it('surfaces schema violations without echoing secret values', async () => {
		const bad = { ...authoring, host: 42 };
		const err = await sealConfig({
			schema,
			paths,
			authoring: bad as unknown as Record<string, unknown>,
			seal: fakeSeal(),
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ValidationError);
		expect((err as Error).message).not.toContain('hunter2');
	});

	it('fails closed on an unsupported stored secret shape at open time', async () => {
		const stored = await storedConfig();
		(stored.auth as Record<string, unknown>).password = { $secret: { kind: 'future' } };
		await expect(openConfig({ stored, paths, open: fakeOpen })).rejects.toThrow(
			/unsupported stored shape/,
		);
	});

	it('rejects an empty-string secret value instead of sealing it', async () => {
		await expect(
			sealConfig({
				schema,
				paths,
				authoring: { ...authoring, auth: { ...authoring.auth, password: '' } },
				seal: fakeSeal(),
			}),
		).rejects.toThrow(ValidationError);
	});
});

describe('keep-markers in nested arrays', () => {
	const nestedSchema = z.object({
		groups: z.array(
			z.object({
				name: z.string(),
				members: z.array(z.object({ name: z.string(), token: zSecret() })),
			}),
		),
	});
	const nestedPaths = secretPaths(
		z.toJSONSchema(nestedSchema, { io: 'input' }) as Record<string, unknown>,
	);
	const keep = { $secret: { set: true } };

	it('matches every wildcard level by name across an inner reorder', async () => {
		const previous = await sealConfig({
			schema: nestedSchema,
			paths: nestedPaths,
			authoring: {
				groups: [
					{
						name: 'g1',
						members: [
							{ name: 'm1', token: 't1' },
							{ name: 'm2', token: 't2' },
						],
					},
					{ name: 'g2', members: [{ name: 'm3', token: 't3' }] },
				],
			},
			seal: fakeSeal(),
		});
		const stored = await sealConfig({
			schema: nestedSchema,
			paths: nestedPaths,
			authoring: {
				groups: [
					{ name: 'g2', members: [{ name: 'm3', token: keep }] },
					{
						name: 'g1',
						members: [
							{ name: 'm2', token: keep },
							{ name: 'm1', token: keep },
						],
					},
				],
			},
			previous,
			seal: fakeSeal(),
		});
		expect(await openConfig({ stored, paths: nestedPaths, open: fakeOpen })).toEqual({
			groups: [
				{ name: 'g2', members: [{ name: 'm3', token: 't3' }] },
				{
					name: 'g1',
					members: [
						{ name: 'm2', token: 't2' },
						{ name: 'm1', token: 't1' },
					],
				},
			],
		});
	});

	it('rejects a keep-marker for an inner entry that did not exist', async () => {
		const previous = await sealConfig({
			schema: nestedSchema,
			paths: nestedPaths,
			authoring: { groups: [{ name: 'g1', members: [{ name: 'm1', token: 't1' }] }] },
			seal: fakeSeal(),
		});
		await expect(
			sealConfig({
				schema: nestedSchema,
				paths: nestedPaths,
				authoring: { groups: [{ name: 'g1', members: [{ name: 'new', token: keep }] }] },
				previous,
				seal: fakeSeal(),
			}),
		).rejects.toThrow(/no stored encrypted value to keep/);
	});
});

describe('findStraySecretBoxes', () => {
	it('flags boxes off the registered paths, including inside array items', async () => {
		const stored = await sealConfig({
			schema,
			paths,
			authoring: {
				host: 'h',
				auth: { method: 'basic', user: 'u', password: 'pw' },
				secrets: [{ name: 'A', value: 'aaa' }],
			},
			seal: fakeSeal(),
		});
		expect(findStraySecretBoxes(stored, paths)).toEqual([]);

		stored.rogue = {
			$secret: { kind: 'managed', envelope: { ciphertext: 'x' } },
		};
		(stored.secrets as Record<string, unknown>[])[0].shadow = { $secret: { set: true } };
		expect(findStraySecretBoxes(stored, paths).sort((a, b) => a.localeCompare(b))).toEqual([
			'rogue',
			'secrets.0.shadow',
		]);
	});
});
