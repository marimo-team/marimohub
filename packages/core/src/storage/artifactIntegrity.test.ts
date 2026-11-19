import { describe, expect, it, vi } from 'vitest';
import { MemoryBucket } from '../testing/MemoryBucket';
import { matchesArtifactDigest } from './artifactIntegrity';
import { sha256Hex } from '../internal/sha256';

describe('artifact integrity', () => {
	it.each([new Uint8Array(), new Uint8Array([0, 128, 255])])(
		'accepts intact bytes: %j',
		async (bytes) => {
			const bucket = new MemoryBucket();
			await bucket.put('artifact', bytes);
			expect(
				await matchesArtifactDigest(await bucket.get('artifact'), {
					size_bytes: bytes.length,
					sha256: await sha256Hex(bytes),
				}),
			).toBe(true);
		},
	);
	it('rejects missing artifacts even when empty content is expected', async () => {
		expect(await matchesArtifactDigest(null, { size_bytes: 0, sha256: await sha256Hex('') })).toBe(
			false,
		);
	});
	it('rejects a size mismatch before reading content', async () => {
		const bucket = new MemoryBucket();
		await bucket.put('artifact', 'abc');
		const artifact = (await bucket.get('artifact'))!;
		const read = vi.spyOn(artifact, 'bytes');
		expect(
			await matchesArtifactDigest(artifact, { size_bytes: 4, sha256: await sha256Hex('abcd') }),
		).toBe(false);
		expect(read).not.toHaveBeenCalled();
	});
	it('rejects corrupted content of the expected size', async () => {
		const bucket = new MemoryBucket();
		await bucket.put('artifact', 'abd');
		expect(
			await matchesArtifactDigest(await bucket.get('artifact'), {
				size_bytes: 3,
				sha256: await sha256Hex('abc'),
			}),
		).toBe(false);
	});
	it('propagates storage read failures', async () => {
		const bucket = new MemoryBucket();
		await bucket.put('artifact', 'abc');
		const artifact = (await bucket.get('artifact'))!;
		vi.spyOn(artifact, 'bytes').mockRejectedValue(new Error('read failed'));
		await expect(
			matchesArtifactDigest(artifact, { size_bytes: 3, sha256: await sha256Hex('abc') }),
		).rejects.toThrow('read failed');
	});
});
