import { useState } from 'react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { deferred } from '@/test/deferred';
import { SchemaForm } from './SchemaForm';
import { TextFileImport } from './TextFileImport';
import { buildDefaults, KEEP_SECRET, pruneForSubmit, validateValue } from './model';
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
	required: ['name', 'api_key', 'mode'],
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
		expect(
			screen.getByRole('link', { name: 'Read the secret manager documentation' }),
		).toHaveAttribute('href', 'https://example.com/secret-locators');
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

describe('optional object sections', () => {
	const settings: JsonSchemaNode = {
		type: 'object',
		required: ['endpoint'],
		properties: {
			endpoint: { type: 'string' },
			region: { type: 'string', default: 'us-east-1' },
		},
	};
	const section: JsonSchemaNode = { type: 'object', properties: { settings } };
	const cases: { name: string; schema: JsonSchemaNode; initial: Record<string, unknown> }[] = [
		{ name: 'root', schema: section, initial: {} },
		{
			name: 'nested object',
			schema: { type: 'object', required: ['connection'], properties: { connection: section } },
			initial: { connection: {} },
		},
		{
			name: 'union branch',
			schema: {
				type: 'object',
				required: ['storage'],
				properties: {
					storage: {
						oneOf: [
							{
								...section,
								required: ['scheme'],
								properties: { scheme: { const: 'catalog' }, settings },
							},
						],
					},
				},
			},
			initial: { storage: { scheme: 'catalog' } },
		},
		{
			name: 'array item',
			schema: { type: 'object', properties: { connections: { type: 'array', items: section } } },
			initial: { connections: [{}] },
		},
		{
			name: 'optional union',
			schema: {
				type: 'object',
				properties: {
					settings: {
						anyOf: [
							{ ...settings, properties: { method: { const: 'custom' }, ...settings.properties } },
						],
					},
				},
			},
			initial: {},
		},
	];

	function OptionalHarness({ schema: formSchema, initial }: (typeof cases)[number]) {
		const [value, setValue] = useState(initial);
		return (
			<>
				<SchemaForm
					schema={formSchema}
					hints={{}}
					value={value}
					onChange={setValue}
					errors={validateValue(formSchema, value)}
				/>
				<output data-testid="submitted">{JSON.stringify(pruneForSubmit(formSchema, value))}</output>
			</>
		);
	}

	it.each(cases)(
		'enables, validates, and removes an optional object in a $name',
		async (testCase) => {
			const user = userEvent.setup();
			render(<OptionalHarness {...testCase} />);
			const toggle = screen.getByRole('switch', { name: 'Enable Settings' });
			expect(toggle).toHaveAttribute('aria-checked', 'false');
			expect(screen.queryByLabelText('Endpoint')).not.toBeInTheDocument();
			expect(screen.getByTestId('submitted')).toHaveTextContent(JSON.stringify(testCase.initial));

			await user.click(toggle);
			expect(screen.getByLabelText('Region')).toHaveValue('us-east-1');
			expect(screen.getByText('Required')).toBeInTheDocument();
			await user.type(screen.getByLabelText('Endpoint'), 'https://objects.example.com');
			expect(screen.queryByText('Required')).not.toBeInTheDocument();
			expect(screen.getByTestId('submitted')).toHaveTextContent('https://objects.example.com');

			await user.click(toggle);
			expect(screen.queryByLabelText('Endpoint')).not.toBeInTheDocument();
			expect(screen.getByTestId('submitted')).toHaveTextContent(JSON.stringify(testCase.initial));
		},
	);

	it('opens an existing optional object and allows removing it', async () => {
		const user = userEvent.setup();
		render(
			<OptionalHarness
				name="existing"
				schema={section}
				initial={{ settings: { endpoint: 'https://objects.example.com' } }}
			/>,
		);
		const toggle = screen.getByRole('switch', { name: 'Enable Settings' });
		expect(toggle).toHaveAttribute('aria-checked', 'true');
		expect(screen.getByLabelText('Endpoint')).toHaveValue('https://objects.example.com');
		await user.click(toggle);
		expect(screen.getByTestId('submitted')).toHaveTextContent('{}');
	});
});

describe('textarea widget', () => {
	// Mirrors Trino/Iceberg REST: the textarea hints sit on union-branch paths
	// (`tls.ca_bundle`), and their material is multi-line PEM or krb5.conf.
	const tlsSchema: JsonSchemaNode = {
		type: 'object',
		required: ['host', 'tls'],
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

describe('advanced union fields', () => {
	const storageSchema: JsonSchemaNode = {
		type: 'object',
		required: ['storage'],
		properties: {
			storage: {
				oneOf: [
					{
						type: 'object',
						properties: {
							scheme: { type: 'string', const: 's3' },
							endpoint: { type: 'string' },
							broker_read_locations: { type: 'array', items: { type: 'object' } },
						},
					},
				],
			},
		},
	};

	it('renders advanced hints in a nested disclosure', async () => {
		const user = userEvent.setup();
		const value = buildDefaults(storageSchema) as Record<string, unknown>;
		render(
			<SchemaForm
				schema={storageSchema}
				hints={{ 'storage.broker_read_locations': { advanced: true } }}
				value={value}
				onChange={() => {}}
			/>,
		);

		expect(screen.getByLabelText('Endpoint')).toBeVisible();
		expect(screen.getByText('Advanced').closest('details')).not.toHaveAttribute('open');
		expect(screen.getByText('Broker read locations')).not.toBeVisible();

		await user.click(screen.getByText('Advanced'));
		expect(screen.getByText('Broker read locations')).toBeVisible();
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

describe('agent skill editor', () => {
	const agentSchema: JsonSchemaNode = {
		type: 'object',
		properties: {
			instructions: { type: 'string' },
			skills: {
				type: 'array',
				items: {
					type: 'object',
					required: ['name', 'content'],
					properties: { name: { type: 'string' }, content: { type: 'string' } },
				},
			},
		},
	};
	function AgentHarness() {
		const [value, setValue] = useState<Record<string, unknown>>({});
		return (
			<>
				<SchemaForm
					schema={agentSchema}
					hints={{
						instructions: { widget: 'textarea' },
						'skills.*.content': { widget: 'textarea' },
					}}
					value={value}
					onChange={setValue}
				/>
				<output>{JSON.stringify(value)}</output>
			</>
		);
	}
	it('adds, edits, and removes skills while preserving Markdown newlines', async () => {
		const user = userEvent.setup();
		render(<AgentHarness />);
		await user.type(screen.getByLabelText('Instructions'), '# Team{enter}Use polars.');
		await user.click(screen.getByRole('button', { name: 'Add' }));
		await user.type(screen.getByLabelText('Name'), 'analytics');
		const content = screen.getByLabelText('Content');
		expect(content.tagName).toBe('TEXTAREA');
		await user.type(content, '---{enter}name: analytics{enter}---{enter}Analyze data.');
		expect(JSON.parse(screen.getByRole('status').textContent ?? '')).toEqual({
			instructions: '# Team\nUse polars.',
			skills: [{ name: 'analytics', content: '---\nname: analytics\n---\nAnalyze data.' }],
		});
		await user.click(screen.getByRole('button', { name: 'Remove' }));
		expect(screen.queryByLabelText('Content')).not.toBeInTheDocument();
		expect(JSON.parse(screen.getByRole('status').textContent ?? '')).toMatchObject({ skills: [] });
	});
});

describe('text file import', () => {
	function Harness({ node }: { node: JsonSchemaNode }) {
		const [value, setValue] = useState<Record<string, unknown>>({ script: 'existing' });
		return (
			<SchemaForm
				schema={{
					type: 'object',
					properties: { script: node, name: { type: 'string' } },
				}}
				hints={{ script: { widget: 'textarea', file_accept: ['.sh'] } }}
				value={value}
				onChange={setValue}
			/>
		);
	}
	function setupImport(node: JsonSchemaNode = { type: 'string', 'x-max-utf8-bytes': 100 }) {
		const user = userEvent.setup();
		const { container } = render(<Harness node={node} />);
		return {
			user,
			upload: (file: File) =>
				user.upload(container.querySelector<HTMLInputElement>('input[type="file"]')!, file),
		};
	}

	function textFile(
		content: string | Uint8Array<ArrayBuffer>,
		name: string,
		read?: () => Promise<ArrayBuffer>,
	): File {
		const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
		const file = new File([bytes], name, { type: 'text/plain' });
		// jsdom does not implement File.arrayBuffer().
		Object.defineProperty(file, 'arrayBuffer', { value: read ?? (async () => bytes.buffer) });
		return file;
	}

	it('imports a shell file into an editable textarea without losing newlines', async () => {
		const { user, upload } = setupImport();
		const file = textFile('#!/bin/sh\necho ready\n', 'startup.sh');
		expect(screen.getByRole('button', { name: 'Import file for Script' })).toBeInTheDocument();
		await upload(file);
		await waitFor(() =>
			expect(screen.getByLabelText('Script')).toHaveValue('#!/bin/sh\necho ready\n'),
		);
		await user.type(screen.getByLabelText('Script'), 'echo edited');
		expect(screen.getByLabelText('Script')).toHaveValue('#!/bin/sh\necho ready\necho edited');
	});
	it('rejects an oversized file before reading it and preserves the current value', async () => {
		const { upload } = setupImport();
		const read = vi.fn();
		const file = textFile('x'.repeat(101), 'large.sh', read);
		await upload(file);
		expect(screen.getByRole('alert')).toHaveTextContent('File must be at most 100 bytes.');
		expect(read).not.toHaveBeenCalled();
		expect(screen.getByLabelText('Script')).toHaveValue('existing');
	});
	it('reports read failures without discarding the current script', async () => {
		const { upload } = setupImport();
		const file = textFile('echo ready', 'unreadable.sh', async () => {
			throw new Error('read failed');
		});
		await upload(file);
		expect(await screen.findByRole('alert')).toHaveTextContent('Could not read this file.');
		expect(screen.getByLabelText('Script')).toHaveValue('existing');
	});
	it.each([
		['Latin-1', [0xe9]],
		['Windows-1252', [0x93, 0x61, 0x94]],
		['truncated UTF-8', [0xe2, 0x82]],
	])('rejects %s bytes without replacing the script', async (_, bytes) => {
		const { upload } = setupImport();
		await upload(textFile(new Uint8Array(bytes), 'invalid.sh'));
		expect(await screen.findByRole('alert')).toHaveTextContent('Could not read this file.');
		expect(screen.getByLabelText('Script')).toHaveValue('existing');
	});
	it('preserves valid UTF-8 including a literal replacement character', async () => {
		const { upload } = setupImport();
		const content = 'echo "café 日本語 �"\n';
		await upload(textFile(content, 'unicode.sh'));
		await waitFor(() => expect(screen.getByLabelText('Script')).toHaveValue(content));
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
	});
	it.each(['resolve', 'reject'] as const)(
		'ignores an import that completes with %s after textarea edits',
		async (outcome) => {
			const { user, upload } = setupImport();
			const pending = deferred<ArrayBuffer>();
			await upload(textFile('old', 'old.sh', () => pending.promise));
			await user.type(screen.getByLabelText('Script'), ' edited');
			await act(async () => {
				if (outcome === 'resolve') pending.resolve(new TextEncoder().encode('stale').buffer);
				else pending.reject(new Error('stale failure'));
			});
			expect(screen.getByLabelText('Script')).toHaveValue('existing edited');
			expect(screen.queryByRole('alert')).not.toBeInTheDocument();
			await upload(textFile('echo retry', 'retry.sh'));
			await waitFor(() => expect(screen.getByLabelText('Script')).toHaveValue('echo retry'));
		},
	);
	it('keeps an import invalidated when the textarea is edited back to its original value', async () => {
		const { user, upload } = setupImport();
		const pending = deferred<ArrayBuffer>();
		await upload(textFile('old', 'old.sh', () => pending.promise));
		await user.type(screen.getByLabelText('Script'), 'x{Backspace}');
		await act(async () => pending.resolve(new TextEncoder().encode('stale').buffer));
		expect(screen.getByLabelText('Script')).toHaveValue('existing');
	});
	it('does not update the form when an import finishes after unmounting', async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		const pending = deferred<ArrayBuffer>();
		const { container, unmount } = render(
			<TextFileImport label="Script" accept={['.sh']} onChange={onChange} />,
		);
		await user.upload(
			container.querySelector<HTMLInputElement>('input[type="file"]')!,
			textFile('old', 'old.sh', () => pending.promise),
		);
		unmount();
		await act(async () => pending.resolve(new TextEncoder().encode('stale').buffer));
		expect(onChange).not.toHaveBeenCalled();
	});
	it('preserves edits to another field while importing', async () => {
		const { user, upload } = setupImport();
		const pending = deferred<ArrayBuffer>();
		await upload(textFile('old', 'old.sh', () => pending.promise));
		await user.type(screen.getByLabelText('Name'), 'new name');
		await act(async () => pending.resolve(new TextEncoder().encode('echo ready').buffer));
		expect(screen.getByLabelText('Script')).toHaveValue('echo ready');
		expect(screen.getByLabelText('Name')).toHaveValue('new name');
	});
	it('clears an import error when the textarea is edited', async () => {
		const { user, upload } = setupImport();
		await upload(textFile('x'.repeat(101), 'large.sh'));
		expect(screen.getByRole('alert')).toBeInTheDocument();
		await user.type(screen.getByLabelText('Script'), ' edited');
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
	});
	it('uses the default byte cap when the schema only limits characters', async () => {
		const { upload } = setupImport({ type: 'string', maxLength: 2 });
		const read = vi.fn();
		await upload(textFile('x'.repeat(64 * 1024 + 1), 'large.sh', read));
		expect(screen.getByRole('alert')).toHaveTextContent('File must be at most 65536 bytes.');
		expect(read).not.toHaveBeenCalled();
		await upload(textFile('éé', 'unicode.sh'));
		await waitFor(() => expect(screen.getByLabelText('Script')).toHaveValue('éé'));
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
	});
	it.each(['resolve', 'reject'] as const)(
		'ignores an older import that later completes with %s',
		async (outcome) => {
			const { upload } = setupImport();
			const pending = deferred<ArrayBuffer>();
			const older = textFile('old', 'old.sh', () => pending.promise);
			const newer = textFile('echo new', 'new.sh');
			await upload(older);
			await upload(newer);
			await waitFor(() => expect(screen.getByLabelText('Script')).toHaveValue('echo new'));
			await act(async () => {
				if (outcome === 'resolve')
					pending.resolve(new TextEncoder().encode('stale contents').buffer);
				else pending.reject(new Error('stale failure'));
			});
			expect(screen.getByLabelText('Script')).toHaveValue('echo new');
			expect(screen.queryByRole('alert')).not.toBeInTheDocument();
		},
	);

	it('enforces the byte limit for multibyte text and recovers with a file at the limit', async () => {
		const { upload } = setupImport();
		const readOversized = vi.fn();
		const oversized = textFile('é'.repeat(51), 'oversized.sh', readOversized);
		const atLimit = textFile('é'.repeat(50), 'at-limit.sh');
		await upload(oversized);
		expect(screen.getByRole('alert')).toHaveTextContent('File must be at most 100 bytes.');
		expect(readOversized).not.toHaveBeenCalled();
		await upload(atLimit);
		await waitFor(() => expect(screen.getByLabelText('Script')).toHaveValue('é'.repeat(50)));
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
	});

	it('keeps a later size error when an older pending file read succeeds', async () => {
		const { upload } = setupImport();
		const pending = deferred<ArrayBuffer>();
		const older = textFile('old', 'old.sh', () => pending.promise);
		await upload(older);
		await upload(new File(['x'.repeat(101)], 'large.sh'));
		await act(async () => pending.resolve(new TextEncoder().encode('stale contents').buffer));
		expect(screen.getByLabelText('Script')).toHaveValue('existing');
		expect(screen.getByRole('alert')).toHaveTextContent('File must be at most 100 bytes.');
	});
});
