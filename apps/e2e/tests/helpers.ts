import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

// Unique name so serial reruns against the shared in-memory store don't collide.
export function uniqueName(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
}

// Rows have a stable data-testid; filter by name to avoid matching toasts/headings.
export function projectRow(page: Page, name: string): Locator {
	return page.getByTestId('project-row').filter({ hasText: name });
}

export function notebookRow(page: Page, name: string): Locator {
	return page.getByTestId('notebook-row').filter({ hasText: name });
}

export async function createProject(page: Page, name: string, description?: string): Promise<void> {
	await page.goto('/');
	await page.getByRole('button', { name: 'New Project' }).click();
	await page.getByLabel('Project Name').fill(name);
	if (description) await page.getByLabel('Description').fill(description);
	// `exact` so we hit the dialog submit, not the empty-state "Create your first…".
	await page.getByRole('button', { name: 'Create', exact: true }).click();
	await expect(projectRow(page, name)).toBeVisible();
}

export async function openProject(page: Page, name: string): Promise<void> {
	await page.goto('/');
	await projectRow(page, name).click();
	await expect(page.getByRole('heading', { name })).toBeVisible();
}

export async function createAndOpenProject(
	page: Page,
	name: string,
	description?: string,
): Promise<void> {
	await createProject(page, name, description);
	await openProject(page, name);
}

export async function editProjectName(page: Page, nextName: string): Promise<void> {
	await page.getByRole('button', { name: 'Edit project' }).click();
	await page.getByLabel('Project Name').fill(nextName);
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByRole('heading', { name: nextName })).toBeVisible();
}

/** Delete the currently-open project via its type-to-confirm guard. */
export async function deleteProject(page: Page, name: string): Promise<void> {
	await page.getByRole('button', { name: 'Delete project' }).click();
	await page.getByLabel(`Type "${name}" to confirm`).fill(name);
	// `exact` so we hit the dialog's confirm button, not the "Delete project" icon.
	await page.getByRole('button', { name: 'Delete', exact: true }).click();
}

export async function createNotebook(page: Page, name: string): Promise<void> {
	await page.getByRole('button', { name: 'New Notebook' }).click();
	await page.getByLabel('Notebook Name').fill(name);
	await page.getByRole('button', { name: 'Create', exact: true }).click();
	await expect(notebookRow(page, name)).toBeVisible();
}

export async function deleteNotebook(page: Page, name: string): Promise<void> {
	// Delete lives in the row's "Notebook actions" overflow menu.
	await notebookRow(page, name).getByRole('button', { name: 'Notebook actions' }).click();
	await page.getByRole('menuitem', { name: 'Delete' }).click();
	// `exact` so we hit the dialog's confirm button, not the menu item.
	await page.getByRole('button', { name: 'Delete', exact: true }).click();
}
