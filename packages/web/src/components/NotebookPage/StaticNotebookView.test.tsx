import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { jsonError, renderWithClient } from '@/test/render';
import { StaticNotebookView } from './StaticNotebookView';

const props = { projectId: 'proj-1', notebookId: 'nb-1', title: 'Forecast' };
const path = '/projects/proj-1/notebooks/nb-1';

afterEach(() => vi.unstubAllGlobals());

describe('StaticNotebookView', () => {
	it('keeps app navigation available while outputs load and after they fail', async () => {
		let resolve!: (response: Response) => void;
		vi.stubGlobal(
			'fetch',
			vi.fn(() => new Promise<Response>((done) => (resolve = done))),
		);
		renderWithClient(<StaticNotebookView {...props} canRunApp />, { route: path });

		expect(screen.getByText('Loading outputs...')).toBeVisible();
		const link = screen.getByRole('link', { name: 'Run as app' });
		expect(link).toHaveAttribute('href', `${path}/app`);

		resolve(new Response('unavailable', { status: 503 }));

		expect(await screen.findByText('Failed to load the notebook outputs.')).toBeVisible();
		expect(screen.getByRole('link', { name: 'Run as app' })).toBe(link);
		expect(screen.queryByText(/sessions are disabled/)).toBeNull();
		expect(screen.queryByText('No outputs yet')).toBeNull();
	});

	it('hides app navigation when permission is removed or omitted', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<p>outputs</p>')));
		const { rerender } = renderWithClient(<StaticNotebookView {...props} canRunApp />, {
			route: path,
		});
		await screen.findByTitle('Forecast');
		expect(screen.getByRole('link', { name: 'Run as app' })).toBeVisible();

		for (const canRunApp of [false, undefined]) {
			rerender(<StaticNotebookView {...props} canRunApp={canRunApp} />);
			expect(screen.queryByRole('link', { name: 'Run as app' })).toBeNull();
			expect(screen.getByText(/sessions are disabled for viewers/)).toBeVisible();
		}
	});

	it.each([undefined, 'ver-old'])(
		'keeps standalone snapshots read-only even with app permission (version: %s)',
		async (versionId) => {
			vi.stubGlobal(
				'fetch',
				vi.fn().mockResolvedValue(
					new Response('<p>outputs</p>', {
						headers: { 'X-Marimohub-Version-Id': versionId ?? 'ver-head' },
					}),
				),
			);
			renderWithClient(
				<StaticNotebookView
					{...props}
					variant="standalone"
					canRunApp
					versionId={versionId}
					headVersionId="ver-head"
				/>,
				{ route: `${path}/snapshot` },
			);

			expect(await screen.findByTitle('Forecast')).toHaveAttribute('sandbox', 'allow-scripts');
			expect(screen.queryByRole('link', { name: 'Run as app' })).toBeNull();
			expect(screen.queryByText(/You're a viewer/)).toBeNull();
			expect(
				screen.getByText(
					versionId
						? /the notebook has changed since these outputs were captured/
						: /captured when the last editing session ended/,
				),
			).toBeVisible();
		},
	);

	it('keeps the pinned-version empty state without offering to run the current app', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonError('NO_HTML_SNAPSHOT', 'none', 404)));
		renderWithClient(
			<StaticNotebookView {...props} variant="standalone" canRunApp versionId="ver-old" />,
			{ route: `${path}/snapshot?version=ver-old` },
		);

		expect(await screen.findByText('No outputs for this version')).toBeVisible();
		expect(screen.queryByRole('link', { name: 'Run as app' })).toBeNull();
		expect(screen.queryByText(/You're a viewer/)).toBeNull();
	});
});
