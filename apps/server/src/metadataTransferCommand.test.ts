import { afterEach, expect, it, vi } from 'vitest';
import { MetadataTransferError } from '@marimo-hub/core/errors';
vi.mock('node:util', () => ({
	parseArgs: () => ({ values: { input: 'transfer.json', 'writers-stopped': true } }),
}));
vi.mock('node:fs/promises', () => ({
	readFile: async () =>
		JSON.stringify({ namespace: 'hub', id: '11111111-1111-4111-8111-111111111111' }),
}));
vi.mock('@marimo-hub/config', () => ({
	loadAdapterLibraries: async () => ({}),
	makeStorage: () => ({}),
}));
vi.mock('@marimo-hub/config/metadata.node', () => ({ runMetadataTransfer: vi.fn() }));
import { runMetadataTransfer } from '@marimo-hub/config/metadata.node';
import { metadataTransferCommand } from './metadataTransferCommand';
afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});
it('preserves actionable transfer errors', async () => {
	vi.stubEnv('MARIMOHUB_METADATA_ADMIN_POSTGRES_URL', 'postgres://unused');
	vi.mocked(runMetadataTransfer).mockRejectedValue(
		new MetadataTransferError('Drain app pools before metadata transfer'),
	);
	await expect(metadataTransferCommand(false)).rejects.toThrow(
		'Drain app pools before metadata transfer',
	);
});
it('hides raw driver and third-party errors', async () => {
	vi.stubEnv('MARIMOHUB_METADATA_ADMIN_POSTGRES_URL', 'postgres://unused');
	vi.mocked(runMetadataTransfer).mockRejectedValue(new Error('password=secret record=private'));
	const result = metadataTransferCommand(false);
	await expect(result).rejects.toThrow('Metadata transfer stopped');
	await expect(result).rejects.not.toThrow('secret');
});
