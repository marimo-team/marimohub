import { test, expect } from '@playwright/test';
import {
	createProject,
	openProject,
	createNotebook,
	deleteNotebook,
	notebookRow,
	uniqueName,
} from './helpers';

test('notebook lifecycle: create, list, delete', async ({ page }) => {
	const project = uniqueName('proj');
	const notebook = uniqueName('nb');

	await createProject(page, project);
	await openProject(page, project);

	// CRUD only — we don't open the notebook, since running a kernel needs compute.
	await createNotebook(page, notebook);

	await deleteNotebook(page, notebook);
	await expect(notebookRow(page, notebook)).toHaveCount(0);
	await expect(page.getByText('No notebooks yet')).toBeVisible();
});
