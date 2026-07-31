import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../errors';
import { AesGcmSecretCodec } from './AesGcmSecretCodec';

const KEK = '4HMqFRKdJGH9AJeVOu3hINa5G/SfWDuHEzhSszvY9/k=';
const OTHER_KEK = 'SAMy11e5VDu8DXWaGKn1TWSP5a+c37Mcq9xfrRDDNwc=';
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
		const other = new AesGcmSecretCodec({ kek: OTHER_KEK, kekId: 'kek-b' });
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
		const c = await new AesGcmSecretCodec({ kek: OTHER_KEK }).encrypt('v', { path: PATH });
		expect(a.kek_id).toBe(b.kek_id);
		expect(a.kek_id).not.toBe(c.kek_id);
	});

	it.each([
		['too short', 'short'],
		['a 32-character passphrase', 'correct horse battery staple x'.padEnd(32, '!')],
		// 32 base64url characters decode to only 24 bytes.
		['a padded token-looking string', 'test-kek-'.padEnd(32, 'x')],
		['a low-entropy value of the right byte length', 'k'.repeat(44)],
		['a repeated-byte hex key', 'ab'.repeat(32)],
		['a 31-byte key', 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHg'],
	])('rejects %s as key material', (_label, kek) => {
		expect(() => new AesGcmSecretCodec({ kek })).toThrow(/random bytes encoded as base64 or hex/);
	});

	it.each([
		['base64 with padding', KEK],
		['base64url without padding', KEK.replaceAll('+', '-').replaceAll('/', '_').replace('=', '')],
		['hex', '8a6a4c1c15ea9c0ea4c49045d40feb16766b370a6b24f22cb335dbd4de5813ba'],
	])('accepts %s key material', (_label, kek) => {
		expect(() => new AesGcmSecretCodec({ kek })).not.toThrow();
	});

	it('never echoes the rejected KEK in the error', () => {
		const weak = 'super-secret-passphrase-value!!!';
		const err = ((): Error => {
			try {
				new AesGcmSecretCodec({ kek: weak });
				throw new Error('expected a rejection');
			} catch (e) {
				return e as Error;
			}
		})();
		expect(err.message).not.toContain(weak);
	});
});
