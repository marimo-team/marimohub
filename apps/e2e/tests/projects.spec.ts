import { test, expect } from '@playwright/test';
import {
	createAndOpenProject,
	openProject,
	editProjectName,
	deleteProject,
	projectRow,
	uniqueName,
} from './helpers';

test('project lifecycle: create, list, edit, delete', async ({ page }) => {
	const name = uniqueName('proj');
	// Distinct from `name` (not a suffix) so the substring row filter can assert
	// the old name is gone after the rename.
	const renamed = uniqueName('proj-renamed');

	await createAndOpenProject(page, name, 'an e2e project');
	await editProjectName(page, renamed);

	await page.goto('/');
	await expect(projectRow(page, renamed)).toBeVisible();
	await expect(projectRow(page, name)).toHaveCount(0);

	await openProject(page, renamed);
	await deleteProject(page, renamed);
	await expect(page).toHaveURL('/');
	await expect(projectRow(page, renamed)).toHaveCount(0);
});

test('create project: submit is disabled until a name is entered', async ({ page }) => {
	await page.goto('/');
	await page.getByRole('button', { name: 'New Project' }).click();

	const submit = page.getByRole('button', { name: 'Create', exact: true });
	await expect(submit).toBeDisabled();

	await page.getByLabel('Project Name').fill(uniqueName('proj'));
	await expect(submit).toBeEnabled();
});

test('delete project: confirm is disabled until the exact name is typed', async ({ page }) => {
	const name = uniqueName('proj');
	await createAndOpenProject(page, name);

	await page.getByRole('button', { name: 'Delete project' }).click();
	const confirm = page.getByRole('button', { name: 'Delete', exact: true });
	await expect(confirm).toBeDisabled();

	await page.getByLabel(`Type "${name}" to confirm`).fill('not-the-name');
	await expect(confirm).toBeDisabled();
	await page.getByLabel(`Type "${name}" to confirm`).fill(name);
	await expect(confirm).toBeEnabled();
});
