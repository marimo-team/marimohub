import { describe, expect, it } from 'vitest';
import {
	BUCKET_REQUIRED_METHODS,
	SANDBOX_INSTANCE_REQUIRED_METHODS,
	SANDBOX_PROVIDER_REQUIRED_METHODS,
	missingBucketMethods,
	missingSandboxInstanceMethods,
	missingSandboxProviderMethods,
} from './adapterShape';

function shape(methods: readonly string[]): Record<string, () => void> {
	return Object.fromEntries(methods.map((method) => [method, () => {}]));
}

describe('adapter shape validation', () => {
	it('accepts conforming adapter shapes', () => {
		expect(missingBucketMethods(shape(BUCKET_REQUIRED_METHODS))).toEqual([]);
		expect(missingSandboxProviderMethods(shape(SANDBOX_PROVIDER_REQUIRED_METHODS))).toEqual([]);
		expect(missingSandboxInstanceMethods(shape(SANDBOX_INSTANCE_REQUIRED_METHODS))).toEqual([]);
	});

	it('reports missing and non-callable methods in contract order', () => {
		const bucket = shape(BUCKET_REQUIRED_METHODS);
		delete bucket.put;
		bucket.list = undefined as unknown as () => void;
		expect(missingBucketMethods(bucket)).toEqual(['put', 'list']);
	});

	it('reports the full surface for non-object values', () => {
		expect(missingSandboxProviderMethods(null)).toEqual([...SANDBOX_PROVIDER_REQUIRED_METHODS]);
		expect(missingSandboxInstanceMethods('invalid')).toEqual([
			...SANDBOX_INSTANCE_REQUIRED_METHODS,
		]);
	});
});
