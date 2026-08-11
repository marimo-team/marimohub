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

async function expectNoProjectSessions(page: Page, projectId: string): Promise<void> {
	await expect
		.poll(async () => (await listProjectSessions(page, projectId)).length, { timeout: 120_000 })
		.toBe(0);
}

test.describe('session lifecycle', () => {
	test.setTimeout(420_000);

	test.afterEach(async ({ page }) => {
		const projectId = projectIdFromUrl(page.url());
		if (!projectId) return;

		const sessions = await listProjectSessions(page, projectId).catch(() => null);
		if (!sessions) return;

		for (const session of sessions) {
			if (session.status === 'running' || session.status === 'starting') {
				await page.request
					.delete(
						`/api/v1/projects/${projectId}/notebooks/${session.notebook_id}/sessions/${session.session_id}`,
					)
					.catch(() => {});
			}
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
