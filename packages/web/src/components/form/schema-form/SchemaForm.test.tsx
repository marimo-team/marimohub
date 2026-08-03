import { useState } from 'react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SchemaForm } from './SchemaForm';
import { buildDefaults, KEEP_SECRET } from './model';
import type { JsonSchemaNode, SecretSources, UiHints } from './model';

const awsSecretSource = {
	backend: 'aws-sm',
	title: 'AWS Secrets Manager',
	locator_placeholder: 'Secret ID or ARN, optionally followed by #json-key',
	locator_help: 'Use secret-id-or-arn[#json-key].',
	docs_url: 'https://example.com/secret-locators',
};

/** Fixture covering required, secret, union, and defaulted widgets. */
const schema: JsonSchemaNode = {
	type: 'object',
	required: ['name', 'api_key'],
	properties: {
		name: { type: 'string' },
		api_key: { type: 'string', minLength: 1, 'x-marimohub-secret': true },
		mode: {
			oneOf: [
				{
					type: 'object',
					required: ['method'],
					properties: { method: { type: 'string', const: 'none' } },
				},
				{
					type: 'object',
					required: ['method', 'user'],
					properties: {
						method: { type: 'string', const: 'basic' },
						user: { type: 'string' },
					},
				},
			],
		},
		debug: { type: 'boolean', default: true },
	},
};

const hints: UiHints = {};

function Harness({
	initialValue,
	editing,
	secretSources,
}: {
	initialValue?: Record<string, unknown>;
	editing?: boolean;
	secretSources?: SecretSources;
}) {
	const [value, setValue] = useState<Record<string, unknown>>(
		() => initialValue ?? (buildDefaults(schema) as Record<string, unknown>),
	);
	return (
		<SchemaForm
			schema={schema}
			hints={hints}
			value={value}
			onChange={setValue}
			editing={editing}
			secretSources={secretSources}
		/>
	);
}

beforeEach(() => {
	// jsdom has no matchMedia; the secret field's restore-value tooltip
	// (via Tooltip -> useIsMobile) needs it.
	vi.stubGlobal('matchMedia', (query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addEventListener: () => {},
		removeEventListener: () => {},
		addListener: () => {},
		removeListener: () => {},
		dispatchEvent: () => false,
	}));
});

afterEach(() => vi.unstubAllGlobals());

describe('SchemaForm', () => {
	it('updates the input value as you type into a string field', async () => {
		const user = userEvent.setup();
		render(<Harness />);
		const input = screen.getByLabelText('Name');
		await user.type(input, 'acme');
		expect(input).toHaveValue('acme');
	});

	it('renders the union as a segmented control and swaps fields when the branch changes', async () => {
		const user = userEvent.setup();
		render(<Harness />);
		expect(screen.queryByLabelText('User')).not.toBeInTheDocument();

		await user.click(screen.getByRole('button', { name: 'Basic' }));
		expect(screen.getByLabelText('User')).toHaveValue('');
	});

	it('resets stale fields from the previous branch on switch', async () => {
		const user = userEvent.setup();
		render(<Harness />);

		await user.click(screen.getByRole('button', { name: 'Basic' }));
		await user.type(screen.getByLabelText('User'), 'alice');
		expect(screen.getByLabelText('User')).toHaveValue('alice');

		await user.click(screen.getByRole('button', { name: 'None' }));
		expect(screen.queryByLabelText('User')).not.toBeInTheDocument();

		await user.click(screen.getByRole('button', { name: 'Basic' }));
		expect(screen.getByLabelText('User')).toHaveValue('');
	});

	it('shows a keep-marker secret as "(set)" with a Replace button, swapping to a password input', async () => {
		const user = userEvent.setup();
		render(
			<Harness
				editing
				initialValue={{
					...(buildDefaults(schema) as Record<string, unknown>),
					api_key: KEEP_SECRET,
				}}
			/>,
		);
		expect(screen.getByText(/\(set\)/)).toBeInTheDocument();
		expect(screen.queryByLabelText('Api key')).not.toBeInTheDocument();

		await user.click(screen.getByRole('button', { name: 'Replace' }));
		const input = screen.getByLabelText('Api key');
		expect(input).toHaveValue('');
		expect(input).toHaveAttribute('type', 'password');
	});

	it('switches between encrypted and external secret inputs', async () => {
		const user = userEvent.setup();
		render(
			<Harness
				secretSources={{
					inline: true,
					references: [awsSecretSource],
				}}
			/>,
		);
		expect(screen.getByLabelText('Api key')).toHaveAttribute('type', 'password');
		await user.click(screen.getByRole('button', { name: 'External secret' }));
		expect(screen.getByLabelText('Secret manager')).toHaveValue('aws-sm');
		expect(screen.getByLabelText('Secret locator')).toHaveAttribute(
			'placeholder',
			'Secret ID or ARN, optionally followed by #json-key',
		);
		expect(screen.getByText('Use secret-id-or-arn[#json-key].')).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Learn more' })).toHaveAttribute(
			'href',
			'https://example.com/secret-locators',
		);
		await user.click(screen.getByRole('button', { name: 'Encrypted value' }));
		expect(screen.getByLabelText('Api key')).toHaveAttribute('type', 'password');
	});

	it('shows setup guidance when no secret source is configured', () => {
		render(<Harness secretSources={{ inline: false, references: [] }} />);
		expect(screen.getByText(/no integration secret source/i)).toBeInTheDocument();
		expect(screen.getByText('Unavailable')).toBeInTheDocument();
	});

	it('uses the external form directly when it is the only configured source', () => {
		render(
			<Harness
				secretSources={{
					inline: false,
					references: [awsSecretSource],
				}}
			/>,
		);
		expect(screen.getByLabelText('Secret manager')).toHaveValue('aws-sm');
		expect(screen.getByLabelText('Secret locator')).toBeInTheDocument();
	});

	it('shows a stored reference backend as unavailable when it is no longer configured', () => {
		render(
			<Harness
				editing
				secretSources={{ inline: true, references: [awsSecretSource] }}
				initialValue={{
					...(buildDefaults(schema) as Record<string, unknown>),
					api_key: {
						$secret: { kind: 'reference', backend: 'removed-vault', locator: 'apps/prod' },
					},
				}}
			/>,
		);
		expect(screen.getByLabelText('Secret manager')).toHaveValue('');
		expect(
			screen.getByRole('option', { name: 'Unavailable backend: removed-vault' }),
		).toBeDisabled();
	});

	it('preserves inline and reference drafts while switching sources', async () => {
		const user = userEvent.setup();
		render(<Harness secretSources={{ inline: true, references: [awsSecretSource] }} />);
		await user.type(screen.getByLabelText('Api key'), 'inline-draft');
		await user.click(screen.getByRole('button', { name: 'External secret' }));
		await user.type(screen.getByLabelText('Secret locator'), 'apps/prod#token');
		await user.click(screen.getByRole('button', { name: 'Encrypted value' }));
		expect(screen.getByLabelText('Api key')).toHaveValue('inline-draft');
		await user.click(screen.getByRole('button', { name: 'External secret' }));
		expect(screen.getByLabelText('Secret locator')).toHaveValue('apps/prod#token');
	});

	it('does not offer a managed restore after switching an existing reference to inline', async () => {
		const user = userEvent.setup();
		render(
			<Harness
				editing
				secretSources={{ inline: true, references: [awsSecretSource] }}
				initialValue={{
					...(buildDefaults(schema) as Record<string, unknown>),
					api_key: {
						$secret: { kind: 'reference', backend: 'aws-sm', locator: 'apps/prod#token' },
					},
				}}
			/>,
		);
		await user.click(screen.getByRole('button', { name: 'Encrypted value' }));
		expect(screen.queryByRole('button', { name: 'Restore stored encrypted value' })).toBeNull();
	});

	it('restores an existing managed value after switching away and back', async () => {
		const user = userEvent.setup();
		render(
			<Harness
				editing
				secretSources={{ inline: true, references: [awsSecretSource] }}
				initialValue={{
					...(buildDefaults(schema) as Record<string, unknown>),
					api_key: KEEP_SECRET,
				}}
			/>,
		);
		await user.click(screen.getByRole('button', { name: 'External secret' }));
		await user.click(screen.getByRole('button', { name: 'Encrypted value' }));
		expect(screen.getByText(/\(set\)/)).toBeInTheDocument();
	});

	it('flips aria-checked on the boolean toggle', async () => {
		const user = userEvent.setup();
		render(<Harness />);
		const toggle = screen.getByRole('switch', { name: 'Debug' });
		expect(toggle).toHaveAttribute('aria-checked', 'true');
		await user.click(toggle);
		expect(toggle).toHaveAttribute('aria-checked', 'false');
	});
});

describe('textarea widget', () => {
	// Mirrors Trino/Iceberg REST: the textarea hints sit on union-branch paths
	// (`tls.ca_bundle`), and their material is multi-line PEM or krb5.conf.
	const tlsSchema: JsonSchemaNode = {
		type: 'object',
		required: ['host'],
		properties: {
			host: { type: 'string' },
			tls: {
				oneOf: [
					{
						type: 'object',
						required: ['verification', 'ca_bundle'],
						properties: {
							verification: { type: 'string', const: 'custom_ca' },
							ca_bundle: { type: 'string' },
						},
					},
				],
			},
		},
	};
	const tlsHints: UiHints = { 'tls.ca_bundle': { widget: 'textarea' } };

	function TlsHarness() {
		const [value, setValue] = useState<Record<string, unknown>>(
			() => buildDefaults(tlsSchema) as Record<string, unknown>,
		);
		return <SchemaForm schema={tlsSchema} hints={tlsHints} value={value} onChange={setValue} />;
	}

	it('renders a hinted string as a textarea that keeps newlines, leaving others single-line', async () => {
		const user = userEvent.setup();
		render(<TlsHarness />);
		const bundle = screen.getByLabelText('Ca bundle');
		expect(bundle.tagName).toBe('TEXTAREA');
		expect(screen.getByLabelText('Host').tagName).toBe('INPUT');

		await user.type(
			bundle,
			'-----BEGIN CERTIFICATE-----{enter}abc{enter}-----END CERTIFICATE-----',
		);
		expect(bundle).toHaveValue('-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----');
	});
});

describe('kv-pairs editor', () => {
	// A record widget: rows convert via Object.fromEntries, which silently keeps
	// only the LAST value per key — duplicates/blank names must be called out.
	const kvSchema: JsonSchemaNode = {
		type: 'object',
		properties: {
			vars: { type: 'object', additionalProperties: { type: 'string' }, default: {} },
		},
	};

	function KvHarness() {
		const [value, setValue] = useState<Record<string, unknown>>(
			() => buildDefaults(kvSchema) as Record<string, unknown>,
		);
		return <SchemaForm schema={kvSchema} hints={{}} value={value} onChange={setValue} />;
	}

	it('warns about duplicate and blank names before they silently collapse', async () => {
		const user = userEvent.setup();
		render(<KvHarness />);
		const add = screen.getByRole('button', { name: /Add/ });
		await user.click(add);
		await user.click(add);

		const names = screen.getAllByLabelText('Vars name');
		const values = screen.getAllByLabelText('Vars value');
		await user.type(names[0], 'SAME');
		await user.type(names[1], 'SAME');
		expect(screen.getByText(/Duplicate name/)).toBeInTheDocument();
		expect(screen.getByText(/only the last value will be saved/)).toBeInTheDocument();

		await user.clear(names[1]);
		await user.type(values[1], 'orphan value');
		expect(screen.getByText(/missing its name/)).toBeInTheDocument();
	});
});
