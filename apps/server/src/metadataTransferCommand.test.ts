import { afterEach, expect, it, vi } from 'vitest';
import { MetadataTransferError } from '@marimo-hub/core/errors';
const args = vi.hoisted(() => ({
	values: { input: 'transfer.json', 'writers-stopped': true } as Record<string, unknown>,
}));
vi.mock('node:util', () => ({ parseArgs: () => ({ values: args.values }) }));
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
	args.values = { input: 'transfer.json', 'writers-stopped': true };
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});
it('preserves actionable transfer errors', async () => {
	vi.stubEnv('MARIMOHUB_METADATA_ADMIN_POSTGRES_URL', 'postgres://localhost/unused');
	vi.mocked(runMetadataTransfer).mockRejectedValue(
		new MetadataTransferError('Drain app pools before metadata transfer'),
	);
	await expect(metadataTransferCommand(false)).rejects.toThrow(
		'Drain app pools before metadata transfer',
	);
});
it('hides raw driver and third-party errors', async () => {
	vi.stubEnv('MARIMOHUB_METADATA_ADMIN_POSTGRES_URL', 'postgres://localhost/unused');
	vi.mocked(runMetadataTransfer).mockRejectedValue(new Error('password=secret record=private'));
	const result = metadataTransferCommand(false);
	await expect(result).rejects.toThrow('Metadata transfer stopped');
	await expect(result).rejects.not.toThrow('secret');
});
it('passes --abort to the transfer and refuses it on activation', async () => {
	vi.stubEnv('MARIMOHUB_METADATA_ADMIN_POSTGRES_URL', 'postgres://localhost/unused');
	args.values = { ...args.values, abort: true };
	vi.mocked(runMetadataTransfer).mockResolvedValue({ id: 'x', state: 'aborted' });
	vi.spyOn(console, 'log').mockImplementation(() => {});
	await metadataTransferCommand(false);
	expect(runMetadataTransfer).toHaveBeenCalledWith(
		'postgres://localhost/unused',
		{},
		expect.objectContaining({ abort: true, activate: false }),
	);
	await expect(metadataTransferCommand(true)).rejects.toThrow('not metadata:activate');
});
it('refuses an unverified remote administrative connection', async () => {
	vi.stubEnv('MARIMOHUB_METADATA_ADMIN_POSTGRES_URL', 'postgres://db.example.com/hub');
	await expect(metadataTransferCommand(false)).rejects.toThrow(
		'MARIMOHUB_METADATA_ADMIN_POSTGRES_URL',
	);
	expect(runMetadataTransfer).not.toHaveBeenCalled();
});
