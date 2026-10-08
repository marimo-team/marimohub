// Shared by the package-index kind suites. Not imported by production code.
import { vi } from 'vitest';
import { createProjectId, createSessionId, UserId } from '../../../ids';
import type { IntegrationProbe, SessionRenderContext } from '../../../ports/integrations';
import type { PackageRegistryCredentialProvider } from '../../../ports/packageRegistry';
import { MemoryBucket } from '../../../testing/MemoryBucket';
import { AesGcmSecretCodec } from '../../secrets/AesGcmSecretCodec';
import { OrgIntegrationsStore, ProjectIntegrationsStore } from '../ProjectIntegrationsStore';
import type { IntegrationsStoreOptions } from '../ProjectIntegrationsStore';
import { defaultRegistry } from './index';
import { SAMPLE_CONFIGS } from './sampleConfigs';

export const TEST_KEK = 'sFjp5R6eWYvc9SGtfeYEsQQlMKB8MfP4FdFAD7JAjsw=';

export const actor = UserId.parse('user-test');

export const context: SessionRenderContext = {
	workload: { kind: 'session', id: createSessionId() },
	principal: { userId: actor, email: 'test@example.com' },
};

export function fixture(kind: string): Record<string, unknown> {
	return SAMPLE_CONFIGS[kind] as Record<string, unknown>;
}

/**
 * Project and org stores over one bucket, with a stub registry credential
 * provider minting `fresh-token` and one probe for tests and token minting.
 */
export function packageIndexStores(overrides: Partial<IntegrationsStoreOptions> = {}) {
	const fetch = vi.fn<IntegrationProbe['fetch']>(async () => ({
		ok: true,
		status: 200,
		json: async () => ({}),
	}));
	const resolve = vi.fn<PackageRegistryCredentialProvider['resolve']>(async () => ({
		username: 'aws',
		password: 'fresh-token',
		expiresAt: '2099-01-01T00:00:00.000Z',
	}));
	const probe = { fetch, connect: vi.fn() };
	const options: IntegrationsStoreOptions = {
		bucket: new MemoryBucket(),
		registry: defaultRegistry(),
		codec: new AesGcmSecretCodec({ kek: TEST_KEK }),
		packageRegistryCredentials: { resolve },
		packageRegistryProbe: probe,
		probe,
		...overrides,
	};
	return {
		options,
		fetch,
		resolve,
		projectId: createProjectId(),
		project: new ProjectIntegrationsStore(options),
		org: new OrgIntegrationsStore(options),
	};
}
