import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createAndOpenProject, createNotebook, notebookRow, uniqueName } from './helpers';

interface SessionSummary {
	session_id: string;
	notebook_id: string;
	status: string;
}

function projectIdFromUrl(url: string): string | undefined {
	return url.match(/\/projects\/([^/]+)/)?.[1];
}

async function listProjectSessions(page: Page, projectId: string): Promise<SessionSummary[]> {
	const response = await page.request.get(`/api/v1/projects/${projectId}/sessions`);
	if (!response.ok()) throw new Error(`Failed to list project sessions: ${response.status()}`);

	const body = (await response.json()) as { data?: { items?: SessionSummary[] } };
	return body.data?.items ?? [];
}

async function listProjectSessionsWithRetry(
	page: Page,
	projectId: string,
): Promise<SessionSummary[]> {
	let sessions: SessionSummary[] | undefined;
	await expect(async () => {
		sessions = await listProjectSessions(page, projectId);
	}).toPass({ timeout: 10_000 });
	if (!sessions) throw new Error('Session listing completed without a result');
	return sessions;
}

async function expectNoProjectSessions(page: Page, projectId: string): Promise<void> {
	await expect(async () => {
		const sessions = await listProjectSessions(page, projectId);
		expect(
			sessions,
			`Active project sessions: ${sessions.map((session) => `${session.session_id} (${session.status})`).join(', ')}`,
		).toHaveLength(0);
	}).toPass({ timeout: 120_000 });
}

async function deleteSessionForCleanup(
	page: Page,
	projectId: string,
	session: SessionSummary,
): Promise<void> {
	const path = `/api/v1/projects/${projectId}/notebooks/${session.notebook_id}/sessions/${session.session_id}`;
	const response = await page.request.delete(path).catch((error: unknown) => {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`DELETE ${path} failed: ${detail}`);
	});
	if (!response.ok()) {
		const body = (await response.text()).slice(0, 500);
		throw new Error(`DELETE ${path} returned ${response.status()}${body ? `: ${body}` : ''}`);
	}
}

test.describe('session lifecycle', () => {
	test.setTimeout(420_000);

	test.afterEach(async ({ page }) => {
		const projectId = projectIdFromUrl(page.url());
		if (!projectId) return;

		const sessions = await listProjectSessionsWithRetry(page, projectId);
		const results = await Promise.allSettled(
			sessions
				.filter((session) => session.status === 'running' || session.status === 'starting')
				.map((session) => deleteSessionForCleanup(page, projectId, session)),
		);
		const failures = results.flatMap((result) =>
			result.status === 'rejected'
				? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
				: [],
		);
		if (failures.length > 0) {
			throw new Error(
				`Session cleanup failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`,
			);
		}
		// A terminating session already has a teardown owner; a duplicate DELETE
		// skips sandbox destruction, so wait for the original teardown to finish.
		await expectNoProjectSessions(page, projectId);
	});

	test('starts a session, sends a heartbeat, and stops the kernel', async ({ page }) => {
		const project = uniqueName('proj');
		const notebook = uniqueName('nb');

		await createAndOpenProject(page, project);
		await createNotebook(page, notebook);

		await notebookRow(page, notebook).click();
		await expect(page).toHaveURL(/\/projects\/[^/]+\/notebooks\/[^/]+$/);
		const projectId = projectIdFromUrl(page.url())!;

		const iframe = page.locator('iframe');
		await expect(iframe).toBeVisible({ timeout: 240_000 });
		await expect(iframe).toHaveAttribute('src', /^http:\/\/localhost:\d+\//);

		await page.waitForRequest(
			(request) => request.method() === 'POST' && request.url().includes('/heartbeat'),
			{ timeout: 150_000 },
		);

		await page.getByRole('button', { name: 'Stop', exact: true }).click();
		await page.getByRole('button', { name: 'Stop Sandbox' }).click();
		await expect(page.getByRole('heading', { name: project })).toBeVisible();

		await expectNoProjectSessions(page, projectId);
	});
});
