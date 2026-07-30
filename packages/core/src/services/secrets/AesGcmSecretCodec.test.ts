import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors';
import { AesGcmSecretCodec } from './AesGcmSecretCodec';

const KEK = 'k'.repeat(32);
const PATH = 'projects/proj-x/integrations/intg-y/versions/00001.json';

describe('AesGcmSecretCodec', () => {
	it('round-trips a value and never stores plaintext in the envelope', async () => {
		const codec = new AesGcmSecretCodec({ kek: KEK });
		const envelope = await codec.encrypt('hunter2-☃', { path: PATH });
		expect(JSON.stringify(envelope)).not.toContain('hunter2');
		expect(envelope.alg).toBe('A256GCM');
		expect(await codec.decrypt(envelope, { path: PATH })).toBe('hunter2-☃');
	});

	it('produces a distinct envelope per encryption (fresh IV)', async () => {
		const codec = new AesGcmSecretCodec({ kek: KEK });
		const a = await codec.encrypt('same', { path: PATH });
		const b = await codec.encrypt('same', { path: PATH });
		expect(a.iv).not.toBe(b.iv);
		expect(a.ciphertext).not.toBe(b.ciphertext);
	});

	it('rejects an envelope replayed at a different path', async () => {
		const codec = new AesGcmSecretCodec({ kek: KEK });
		const envelope = await codec.encrypt('value', { path: PATH });
		await expect(codec.decrypt(envelope, { path: 'projects/other/secret.json' })).rejects.toThrow(
			ValidationError,
		);
	});

	it('fails on a wrong KEK, naming the path and never the material', async () => {
		const codec = new AesGcmSecretCodec({ kek: KEK, kekId: 'kek-a' });
		const other = new AesGcmSecretCodec({ kek: 'x'.repeat(32), kekId: 'kek-b' });
		const envelope = await codec.encrypt('value', { path: PATH });
		const err = await other.decrypt(envelope, { path: PATH }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ValidationError);
		const message = (err as Error).message;
		expect(message).toContain(PATH);
		expect(message).not.toContain('value');
		expect(message).not.toContain(KEK);
	});

	it('fails on a tampered ciphertext', async () => {
		const codec = new AesGcmSecretCodec({ kek: KEK });
		const envelope = await codec.encrypt('value', { path: PATH });
		const tampered = { ...envelope, ciphertext: `A${envelope.ciphertext.slice(1)}` };
		await expect(codec.decrypt(tampered, { path: PATH })).rejects.toThrow(ValidationError);
	});

	it('same KEK ⇒ same kek_id; different KEK ⇒ different kek_id', async () => {
		const a = await new AesGcmSecretCodec({ kek: KEK }).encrypt('v', { path: PATH });
		const b = await new AesGcmSecretCodec({ kek: KEK }).encrypt('v', { path: PATH });
		const c = await new AesGcmSecretCodec({ kek: 'y'.repeat(32) }).encrypt('v', { path: PATH });
		expect(a.kek_id).toBe(b.kek_id);
		expect(a.kek_id).not.toBe(c.kek_id);
	});

	it('rejects a KEK shorter than 32 characters', () => {
		expect(() => new AesGcmSecretCodec({ kek: 'short' })).toThrow(/32 characters/);
	});
});
