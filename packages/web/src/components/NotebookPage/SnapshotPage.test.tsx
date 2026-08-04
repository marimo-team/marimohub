import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { SnapshotPage } from './SnapshotPage';
import { jsonError, jsonOk, renderWithClient } from '@/test/render';

const PID = 'proj-x';
const NID = 'nb-1';

/** Route every request the page makes; `html: null` models "never ran" (404). */
function makeFetch(opts: { html: string | null }) {
	const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? 'GET';
		if (url.endsWith(`/notebooks/${NID}/html`)) {
			if (opts.html == null) return jsonError('NO_HTML_SNAPSHOT', 'none', 404);
			return new Response(opts.html, {
				headers: {
					'content-type': 'text/html',
					'X-Marimohub-Captured-At': '2025-03-05T14:00:00Z',
				},
			});
		}
		if (url.endsWith(`/notebooks/${NID}`)) {
			return jsonOk({
				meta: { id: NID, title: 'Forecast', author: 'me' },
				source: { type: 'local', current_version_id: 'ver-head' },
			});
		}
		throw new Error(`unexpected fetch: ${method} ${url}`);
	});
	vi.stubGlobal('fetch', impl);
	return impl;
}

const onlyReads = (impl: ReturnType<typeof makeFetch>) =>
	impl.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET');

function renderPage() {
	return renderWithClient(
		<Routes>
			<Route path="/projects/:pid/notebooks/:nid/snapshot" element={<SnapshotPage />} />
		</Routes>,
		{ route: `/projects/${PID}/notebooks/${NID}/snapshot` },
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('SnapshotPage', () => {
	it('renders the snapshot in an opaque-origin iframe and never starts a session', async () => {
		const impl = makeFetch({ html: '<html><body>outputs</body></html>' });
		const { container } = renderPage();

		await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
		const iframe = container.querySelector('iframe')!;
		expect(iframe.getAttribute('srcdoc')).toContain('outputs');
		// Opaque origin: no allow-same-origin, unlike the live-kernel iframe.
		expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
		expect(screen.getByText(/captured when the last editing session ended/)).toBeInTheDocument();
		// Compute-free by design: reads only, no session create.
		expect(onlyReads(impl)).toBe(true);
	});

	it('shows the empty state when no snapshot has been captured', async () => {
		const impl = makeFetch({ html: null });
		const { container } = renderPage();

		await waitFor(() => expect(screen.getByText('No outputs yet')).toBeInTheDocument());
		expect(container.querySelector('iframe')).toBeNull();
		expect(onlyReads(impl)).toBe(true);
	});

	it('shows the header with the notebook title and a back link to the project', async () => {
		makeFetch({ html: '<html><body>x</body></html>' });
		renderPage();

		expect(await screen.findByText('Forecast')).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Back to project' })).toHaveAttribute(
			'href',
			`/projects/${PID}`,
		);
	});
});
