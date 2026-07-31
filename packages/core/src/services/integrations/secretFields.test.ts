import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ValidationError } from '../../errors';
import type { SecretEnvelope } from '../../ports/secrets';
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
	};
}

const fakeOpen = {
	decrypt: (envelope: SecretEnvelope): Promise<string> =>
		Promise.resolve(atob(envelope.ciphertext)),
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

	it('redacts every stored secret to { $secret: { set: true } }', async () => {
		const stored = await sealConfig({ schema, paths, authoring, seal: fakeSeal() });
		const redacted = redactConfig(stored, paths);
		expect(redacted.auth).toEqual({ method: 'basic', user: 'admin', password: REDACTED_SECRET });
		expect((redacted.secrets as unknown[])[0]).toEqual({ name: 'A', value: REDACTED_SECRET });
		expect(isKeepMarker((redacted.auth as { password: unknown }).password)).toBe(true);
	});

	it('keep-markers reuse the stored value, matching array entries by name across a reorder', async () => {
		const previous = await sealConfig({ schema, paths, authoring, seal: fakeSeal() });
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
		).rejects.toThrow(/must be a string/);
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
		const stored = await sealConfig({ schema, paths, authoring, seal: fakeSeal() });
		(stored.auth as Record<string, unknown>).password = { $secret: { kind: 'future' } };
		await expect(openConfig({ stored, paths, open: fakeOpen })).rejects.toThrow(
			/unsupported stored shape/,
		);
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
		).rejects.toThrow(/no stored value to keep/);
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
