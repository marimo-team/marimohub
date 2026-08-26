import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IID, PID, lakeEntry, objectKind, setup } from './DataBrowserPage.testWorld';

describe('DataBrowserPage object detail', () => {
	it('resets selection to the URL object after back and forward navigation', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&key=first.csv`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectEntries: [
				{ kind: 'object', name: 'first.csv', key: 'first.csv', size: 12 },
				{ kind: 'object', name: 'second.csv', key: 'second.csv', size: 24 },
			],
		});

		await user.click((await screen.findByText('second.csv')).closest('button')!);
		await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('key=second.csv'));
		await user.click(screen.getByTestId('history-back'));
		expect(await screen.findByText('s3://lake/first.csv')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Copy 1 selected URI' }));
		expect(await navigator.clipboard.readText()).toBe('s3://lake/first.csv');

		await user.click(screen.getByTestId('history-forward'));
		expect(await screen.findByText('s3://lake/second.csv')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Copy 1 selected URI' }));
		expect(await navigator.clipboard.readText()).toBe('s3://lake/second.csv');
	});

	it('resets a multi-selection when revisiting its URL through history', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&key=first.csv`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectEntries: [
				{ kind: 'object', name: 'first.csv', key: 'first.csv', size: 12 },
				{ kind: 'object', name: 'second.csv', key: 'second.csv', size: 24 },
			],
		});

		await screen.findByRole('button', { name: /^first\.csv/ });
		const second = screen.getByRole('button', { name: /^second\.csv/ });
		await user.keyboard('{Control>}');
		await user.click(second);
		await user.keyboard('{/Control}');
		expect(screen.getByRole('button', { name: 'Copy 2 selected URIs' })).toBeInTheDocument();
		await user.click(screen.getByTestId('history-back'));
		expect(await screen.findByText('s3://lake/first.csv')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /^first\.csv/ })).toHaveAttribute(
			'aria-pressed',
			'true',
		);
		expect(screen.getByRole('button', { name: /^second\.csv/ })).toHaveAttribute(
			'aria-pressed',
			'false',
		);
		await user.click(screen.getByTestId('history-forward'));
		expect(await screen.findByText('s3://lake/second.csv')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /^first\.csv/ })).toHaveAttribute(
			'aria-pressed',
			'false',
		);
		expect(screen.getByRole('button', { name: /^second\.csv/ })).toHaveAttribute(
			'aria-pressed',
			'true',
		);
		await user.click(screen.getByRole('button', { name: 'Copy 1 selected URI' }));
		expect(await navigator.clipboard.readText()).toBe('s3://lake/second.csv');
	});

	it('does not carry a loaded preview into another object detail', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&key=first.csv`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectEntries: [
				{ kind: 'object', name: 'first.csv', key: 'first.csv', size: 12 },
				{ kind: 'object', name: 'second.csv', key: 'second.csv', size: 24 },
			],
		});

		await user.click(await screen.findByRole('tab', { name: 'Preview' }));
		await user.click(screen.getByRole('button', { name: 'Load preview' }));
		expect(await screen.findByText('hello object')).toBeInTheDocument();
		await user.click(screen.getByText('second.csv').closest('button')!);
		await user.click(await screen.findByRole('tab', { name: 'Preview' }));
		expect(screen.getByRole('button', { name: 'Load preview' })).toBeInTheDocument();
		expect(screen.queryByText('hello object')).not.toBeInTheDocument();
	});

	it('reports rejected key and snippet clipboard writes', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&key=events.jsonl`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
		});
		await screen.findByText('s3://lake/events.jsonl');
		const write = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));

		await user.click(screen.getByRole('button', { name: 'Copy key' }));
		expect(await screen.findByText('Could not copy to clipboard')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Copy snippet' }));
		expect(write).toHaveBeenCalledTimes(2);
	});

	it('preserves URL-sensitive Unicode keys in detail and download links', async () => {
		const key = 'reports/日本語 ?#%/events.jsonl';
		setup(
			`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&key=${encodeURIComponent(key)}`,
			{ kind: objectKind, entry: { ...lakeEntry, kind: 's3' } },
		);

		expect(await screen.findByText(`s3://lake/${key}`)).toBeInTheDocument();
		const download = screen.getByRole('link', { name: 'Download' });
		const target = new URL(download.getAttribute('href')!, 'http://test');
		expect(target.searchParams.get('bucket')).toBe('lake');
		expect(target.searchParams.get('key')).toBe(key);
	});

	it('renders checksums and tags and selects only concrete object versions', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&key=events.jsonl`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectDetail: {
				checksums: [{ algorithm: 'SHA256', value: 'abc123' }],
				metadata: { owner: 'analytics' },
				tags_available: true,
				tags: [{ key: 'environment', value: 'production' }],
				last_modified: '2026-08-12T12:00:00Z',
			},
			objectVersions: [
				{
					bucket: 'lake',
					key: 'events.jsonl',
					version_id: 'v1',
					kind: 'version',
					is_latest: false,
					last_modified: '2026-08-11T12:00:00Z',
				},
				{
					bucket: 'lake',
					key: 'events.jsonl',
					version_id: 'deleted',
					kind: 'delete-marker',
					is_latest: true,
				},
			],
		});

		expect(await screen.findByText('abc123')).toBeInTheDocument();
		expect(screen.getByText('analytics')).toBeInTheDocument();
		expect(screen.getByText('production')).toBeInTheDocument();
		await user.click(screen.getByRole('tab', { name: 'Versions' }));
		expect(screen.getByRole('button', { name: /Delete marker/ })).toBeDisabled();
		await user.click(screen.getByRole('button', { name: /v1/ }));
		await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('version=v1'));
	});

	it.each([
		[
			'tabular',
			{
				kind: 'tabular',
				format: 'csv',
				columns: [{ name: 'name' }],
				rows: [['first'], ['first']],
				truncated: true,
				warnings: ['A malformed final row was omitted.'],
			},
			'A malformed final row was omitted.',
		],
		[
			'image',
			{
				kind: 'image',
				format: 'png',
				content_url: '/api/v1/image-content',
				width: 32,
				height: 16,
				total_bytes: 100,
				warnings: [],
			},
			'Object preview',
		],
		[
			'unsupported',
			{
				kind: 'unsupported',
				reason: 'Archives cannot be previewed safely.',
				total_bytes: 100,
			},
			'Archives cannot be previewed safely.',
		],
	] as const)(
		'renders an explicit %s preview and offers reload',
		async (_kind, preview, expected) => {
			const user = userEvent.setup();
			setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&key=events.jsonl`, {
				kind: objectKind,
				entry: { ...lakeEntry, kind: 's3' },
				objectPreview: preview,
			});
			await user.click(await screen.findByRole('tab', { name: 'Preview' }));
			await user.click(screen.getByRole('button', { name: 'Load preview' }));
			if (_kind === 'image')
				expect(await screen.findByRole('img', { name: expected })).toBeInTheDocument();
			else expect(await screen.findByText(expected)).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Reload preview' })).toBeInTheDocument();
		},
	);

	it('hides server search when the adapter does not provide it', async () => {
		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&q=ignored`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectSearch: 'none',
		});

		expect(await screen.findByText('events.jsonl')).toBeInTheDocument();
		expect(screen.queryByRole('textbox', { name: 'Search object keys' })).not.toBeInTheDocument();
	});

	it('submits bounded object search explicitly and reports partial progress', async () => {
		const user = userEvent.setup();
		const fetchImpl = setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
		});
		await screen.findByText('events.jsonl');
		const input = screen.getByRole('textbox', { name: 'Search object keys' });
		await user.type(input, 'needle');
		expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/objects/search'))).toBe(
			false,
		);
		await user.click(screen.getByRole('button', { name: 'Search object keys' }));
		expect(await screen.findByText('needle.jsonl')).toBeInTheDocument();
		expect(screen.getByText(/matches after scanning/)).toHaveTextContent(
			'1 matches after scanning 5000 keys; more may exist.',
		);
		await user.click(screen.getByRole('button', { name: 'Continue search' }));
		await waitFor(() =>
			expect(
				fetchImpl.mock.calls.some(
					([url]) =>
						String(url).includes('/objects/search') && String(url).includes('cursor=continue'),
				),
			).toBe(true),
		);
	});
});
