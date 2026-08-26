import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
	IID,
	PID,
	azureObjectKind,
	lakeEntry,
	objectKind,
	setup,
} from './DataBrowserPage.testWorld';
import type { ObjectFailure } from './DataBrowserPage.testWorld';

describe('DataBrowserPage object navigation', () => {
	it('reports when browsing is unavailable', async () => {
		setup(`/projects/${PID}/data`, { available: false });
		expect(await screen.findByText('Data browsing is not available')).toBeInTheDocument();
	});

	it('dispatches object-only integrations to the object browser', async () => {
		const fetchImpl = setup(`/projects/${PID}/data/${IID}`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
		});
		expect(await screen.findByText('events.jsonl')).toBeInTheDocument();
		expect(screen.getByText('daily/')).toBeInTheDocument();
		expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/browse/namespaces'))).toBe(
			false,
		);
		expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/browse/objects'))).toBe(
			true,
		);
		expect(screen.getByRole('group', { name: 'Object filters' })).toHaveClass('flex', 'flex-wrap');
	});

	it('opens the detail sheet and closes it from the header button or Escape', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&key=events.jsonl`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
		});

		expect(
			await screen.findByRole('complementary', { name: 'Object details' }),
		).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Close details' }));
		await waitFor(() => expect(screen.getByTestId('location')).not.toHaveTextContent('key='));
		expect(screen.queryByRole('complementary', { name: 'Object details' })).not.toBeInTheDocument();

		await user.click(screen.getByText('events.jsonl').closest('button')!);
		expect(
			await screen.findByRole('complementary', { name: 'Object details' }),
		).toBeInTheDocument();
		await user.keyboard('{Escape}');
		await waitFor(() => expect(screen.getByTestId('location')).not.toHaveTextContent('key='));
	});

	it('copies and downloads through row quick actions without opening the object', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
		});

		await screen.findByText('events.jsonl');
		await user.click(screen.getByRole('button', { name: 'Copy URI for events.jsonl' }));
		expect(await navigator.clipboard.readText()).toBe('s3://lake/events.jsonl');
		await user.click(screen.getByRole('button', { name: 'Copy key for events.jsonl' }));
		expect(await navigator.clipboard.readText()).toBe('events.jsonl');
		const download = screen.getByRole('link', { name: 'Download events.jsonl' });
		const target = new URL(download.getAttribute('href')!, 'http://test');
		expect(target.searchParams.get('key')).toBe('events.jsonl');
		expect(screen.getByTestId('location')).not.toHaveTextContent('key=');
		expect(screen.queryByRole('complementary', { name: 'Object details' })).not.toBeInTheDocument();
	});

	it('navigates upward with the breadcrumb trail from a nested prefix', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&prefix=daily%2Freports%2F`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
		});

		await screen.findByText('events.jsonl');
		await user.click(screen.getByRole('button', { name: 'daily' }));
		await waitFor(() => expect(screen.getByTestId('location')).not.toHaveTextContent('reports'));
		expect(screen.getByTestId('location')).toHaveTextContent('prefix=daily%2F');
		await user.click(screen.getByRole('button', { name: 'lake' }));
		await waitFor(() => expect(screen.getByTestId('location')).not.toHaveTextContent('prefix='));
		// A lone auto-selected bucket makes the root crumb inert.
		expect(screen.getByText('Buckets')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Buckets' })).not.toBeInTheDocument();
	});

	it('selects among discovered buckets and reports empty or failed discovery', async () => {
		const user = userEvent.setup();
		const fetchImpl = setup(`/projects/${PID}/data/${IID}?surface=objects`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectBuckets: [
				{ name: 'lake', configured: false },
				{ name: 'archive', configured: false },
			],
		});
		await user.click(await screen.findByRole('button', { name: 'archive' }));
		await waitFor(() => {
			const listCall = fetchImpl.mock.calls.find(([url]) => {
				const target = new URL(String(url), 'http://test');
				return target.pathname.endsWith('/browse/objects') && target.searchParams.has('bucket');
			});
			expect(new URL(String(listCall?.[0]), 'http://test').searchParams.get('bucket')).toBe(
				'archive',
			);
		});
	});

	it('pages bucket discovery before choosing a bucket', async () => {
		const user = userEvent.setup();
		const fetchImpl = setup(`/projects/${PID}/data/${IID}?surface=objects`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectBuckets: [{ name: 'first', configured: false }],
			objectBucketsSecond: [{ name: 'second', configured: false }],
			objectBucketNextCursor: 'bucket-page-2',
		});

		expect(await screen.findByText('first')).toBeInTheDocument();
		expect(screen.queryByText('second')).not.toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Load more buckets' }));
		expect(await screen.findByText('second')).toBeInTheDocument();
		expect(
			fetchImpl.mock.calls.some(
				([url]) =>
					String(url).includes('/objects/buckets') && String(url).includes('cursor=bucket-page-2'),
			),
		).toBe(true);
	});

	it('keeps loaded buckets visible and retries a failed next page', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?surface=objects`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectBuckets: [{ name: 'first', configured: false }],
			objectBucketsSecond: [{ name: 'second', configured: false }],
			objectBucketNextCursor: 'bucket-page-2',
			objectBucketNextFailure: 'The next bucket page failed.',
		});

		await user.click(await screen.findByRole('button', { name: 'Load more buckets' }));
		expect(await screen.findByText('The next bucket page failed.')).toBeInTheDocument();
		expect(screen.getByText('first')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Retry loading buckets' }));
		expect(await screen.findByText('second')).toBeInTheDocument();
		expect(screen.queryByText('The next bucket page failed.')).not.toBeInTheDocument();
	});

	it('explains when credentials discover no buckets', async () => {
		setup(`/projects/${PID}/data/${IID}?surface=objects`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectBuckets: [],
		});
		expect(await screen.findByText('No buckets available')).toBeInTheDocument();
		expect(
			screen.getByText('The integration credentials did not return an accessible bucket.'),
		).toBeInTheDocument();
	});

	it('uses provider capability metadata for Azure containers and URIs', async () => {
		setup(`/projects/${PID}/data/${IID}?surface=objects`, {
			kind: azureObjectKind,
			entry: { ...lakeEntry, kind: 'azure_blob' },
			objectProvider: 'azure_blob',
			objectRootKind: 'container',
			objectUriScheme: 'az',
			objectBuckets: [],
		});
		expect(await screen.findByText('No containers available')).toBeInTheDocument();
		expect(
			screen.getByText('The integration credentials did not return an accessible container.'),
		).toBeInTheDocument();
	});

	it('handles unknown object capability vocabulary without fabricating a URI', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?surface=objects`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectProvider: 'unknown',
			objectRootKind: 'unknown',
			objectUriScheme: 'unknown',
		});

		await user.click(await screen.findByRole('button', { name: /^events\.jsonl/i }));
		expect(await screen.findByText('lake/events.jsonl')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Copy URI' })).not.toBeInTheDocument();
	});

	it('shows a refetch failure instead of a cached empty bucket state', async () => {
		const user = userEvent.setup();
		const objectFailures: Partial<Record<ObjectFailure, string>> = {};
		setup(`/projects/${PID}/data/${IID}?surface=objects`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectBuckets: [],
			objectFailures,
		});
		expect(await screen.findByText('No buckets available')).toBeInTheDocument();

		objectFailures.buckets = 'Bucket refresh failed.';
		await user.click(screen.getByRole('button', { name: 'Refresh' }));

		expect(await screen.findByText('Bucket refresh failed.')).toBeInTheDocument();
		expect(screen.queryByText('No buckets available')).not.toBeInTheDocument();
	});

	it('shows actionable bucket and object-list failures', async () => {
		setup(`/projects/${PID}/data/${IID}?surface=objects`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectFailures: { buckets: 'Bucket discovery failed. Check S3 permissions.' },
		});
		expect(
			await screen.findByText('Bucket discovery failed. Check S3 permissions.'),
		).toBeInTheDocument();

		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectFailures: { objects: 'Object listing failed. Check ListBucket access.' },
		});
		expect(
			await screen.findByText('Object listing failed. Check ListBucket access.'),
		).toBeInTheDocument();
		expect(screen.queryByLabelText('Filter loaded objects')).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Retry loading objects' })).toBeInTheDocument();
	});

	it('keeps parent-prefix navigation available when the initial listing fails', async () => {
		const user = userEvent.setup();
		setup(`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&prefix=daily%2F`, {
			kind: objectKind,
			entry: { ...lakeEntry, kind: 's3' },
			objectFailures: { objects: 'Object listing failed. Check ListBucket access.' },
		});

		const parentPrefix = await screen.findByRole('button', { name: 'Parent prefix' });
		expect(
			await screen.findByRole('button', { name: 'Retry loading objects' }),
		).toBeInTheDocument();
		await user.click(parentPrefix);

		await waitFor(() => expect(screen.getByTestId('location')).not.toHaveTextContent('prefix='));
	});

	it('round-trips object selection in the URL and loads previews only on request', async () => {
		const user = userEvent.setup();
		const fetchImpl = setup(
			`/projects/${PID}/data/${IID}?surface=objects&bucket=lake&key=events.jsonl`,
			{ kind: objectKind, entry: { ...lakeEntry, kind: 's3' } },
		);
		expect(await screen.findByText('s3://lake/events.jsonl')).toBeInTheDocument();
		expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/objects/preview'))).toBe(
			false,
		);
		await user.click(screen.getByRole('tab', { name: 'Preview' }));
		await user.click(screen.getByRole('button', { name: 'Load preview' }));
		expect(await screen.findByText('hello object')).toBeInTheDocument();
	});
});
