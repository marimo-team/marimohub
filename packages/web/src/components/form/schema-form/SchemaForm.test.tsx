import { useState } from 'react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SchemaForm } from './SchemaForm';
import { buildDefaults, KEEP_SECRET } from './model';
import type { JsonSchemaNode, UiHints } from './model';

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
}: {
	initialValue?: Record<string, unknown>;
	editing?: boolean;
}) {
	const [value, setValue] = useState<Record<string, unknown>>(
		() => initialValue ?? (buildDefaults(schema) as Record<string, unknown>),
	);
	return (
		<SchemaForm schema={schema} hints={hints} value={value} onChange={setValue} editing={editing} />
	);
}

beforeEach(() => {
	// jsdom has no matchMedia; the secret field's "keep stored value" tooltip
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

	it('flips aria-checked on the boolean toggle', async () => {
		const user = userEvent.setup();
		render(<Harness />);
		const toggle = screen.getByRole('switch', { name: 'Debug' });
		expect(toggle).toHaveAttribute('aria-checked', 'true');
		await user.click(toggle);
		expect(toggle).toHaveAttribute('aria-checked', 'false');
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
