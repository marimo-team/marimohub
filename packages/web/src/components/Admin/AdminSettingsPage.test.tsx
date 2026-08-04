import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { jsonError, jsonOk, renderWithClient } from '@/test/render';
import { ErrorBoundary } from '@/components/ui';
import type { DeploymentConfig } from '@/types';
import AdminSettingsPage from './AdminSettingsPage';

const CONFIG: DeploymentConfig = {
	deployment: {
		version: '0.2.0',
		image: 'ghcr.io/marimo-team/marimohub:0.2.0',
		sandbox_image: null,
		started_at: '2026-08-01T00:00:00.000Z',
		replica: 'marimohub-abc123',
		node: 'v24.3.0',
		backends: { storage: 's3', compute: 'coreweave', auth: 'oidc' },
	},
	groups: [
		{
			name: 'Auth',
			backend: 'oidc',
			settings: [
				{
					key: 'MARIMOHUB_AUTH_OIDC_ISSUER',
					name: 'OIDC issuer',
					value: 'https://accounts.example.com',
					secret: false,
					set: true,
				},
				{
					key: 'MARIMOHUB_AUTH_OIDC_CLIENT_SECRET',
					name: 'OIDC client secret',
					value: null,
					secret: true,
					set: true,
				},
				{
					key: 'MARIMOHUB_AUTH_OIDC_AUDIENCE',
					name: 'OIDC audience',
					value: null,
					secret: false,
					set: false,
				},
			],
		},
		{
			name: 'Storage',
			backend: 's3',
			settings: [
				{
					key: 'MARIMOHUB_STORAGE_S3_BUCKET',
					name: 'S3 bucket',
					value: 'my-bucket',
					secret: false,
					set: true,
				},
			],
		},
		// Groups with no applicable settings are hidden entirely.
		{ name: 'Managed AI', backend: 'unset', settings: [] },
	],
	policy: { default_role: 'editor', super_admins: ['ops@example.com', 'user-root'] },
};

function setup(config: DeploymentConfig = CONFIG) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === '/api/v1/admin/config') return jsonOk(config);
			throw new Error(`unexpected fetch: ${url}`);
		}),
	);
	renderWithClient(<AdminSettingsPage />);
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('AdminSettingsPage', () => {
	it('renders the deployment section with a linked release version', async () => {
		setup();

		expect(await screen.findByRole('heading', { name: 'Deployment' })).toBeInTheDocument();
		expect(screen.getByRole('link', { name: /0\.2\.0/ })).toHaveAttribute(
			'href',
			'https://github.com/marimo-team/marimohub/releases/tag/v0.2.0',
		);
		expect(screen.getByText('ghcr.io/marimo-team/marimohub:0.2.0')).toBeInTheDocument();
		expect(screen.getByText('marimohub-abc123')).toBeInTheDocument();
		expect(screen.getByText('s3 · coreweave · oidc')).toBeInTheDocument();
		// Null fields (sandbox image) render no row.
		expect(screen.queryByText('Sandbox image')).not.toBeInTheDocument();
	});

	it('renders every non-empty group with its backend — secrets only as set/not set', async () => {
		setup();

		expect(await screen.findByRole('heading', { name: 'Auth' })).toBeInTheDocument();
		expect(screen.getByText('oidc')).toBeInTheDocument();
		expect(screen.getByText('https://accounts.example.com')).toBeInTheDocument();
		// The secret row shows presence, never a value.
		expect(screen.getByText('OIDC client secret')).toBeInTheDocument();
		expect(screen.getByText('Set')).toBeInTheDocument();
		// Non-secret but unset.
		expect(screen.getByText('Not set')).toBeInTheDocument();

		expect(screen.getByRole('heading', { name: 'Storage' })).toBeInTheDocument();
		expect(screen.getByText('my-bucket')).toBeInTheDocument();

		// The empty Managed AI group is skipped.
		expect(screen.queryByRole('heading', { name: 'Managed AI' })).not.toBeInTheDocument();

		expect(screen.getByText('editor')).toBeInTheDocument();
		expect(screen.getByText('ops@example.com')).toBeInTheDocument();
		expect(screen.getByText('user-root')).toBeInTheDocument();
	});

	it('handles a deployment with no summary (nulls) gracefully', async () => {
		setup({ deployment: null, groups: [], policy: { default_role: null, super_admins: [] } });

		expect(
			await screen.findByText('This deployment reports no configuration.'),
		).toBeInTheDocument();
		expect(screen.queryByRole('heading', { name: 'Deployment' })).not.toBeInTheDocument();
		expect(screen.getByText('none — writes are members-only')).toBeInTheDocument();
		expect(screen.getByText('None configured')).toBeInTheDocument();
	});

	it('surfaces a fetch failure to the error boundary', async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			vi.stubGlobal(
				'fetch',
				vi.fn(async () => jsonError('INTERNAL_ERROR', 'Internal server error', 500)),
			);
			renderWithClient(
				<ErrorBoundary>
					<AdminSettingsPage />
				</ErrorBoundary>,
			);
			expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
			expect(screen.getByText('Internal server error')).toBeInTheDocument();
		} finally {
			log.mockRestore();
		}
	});
});
