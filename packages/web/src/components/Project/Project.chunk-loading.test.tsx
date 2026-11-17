import { expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import type * as TagFieldModule from '@/lib/tagFieldValue';
import { makeFetch, renderProject } from './Project.testWorld';

const binding = vi.hoisted(() => ({
	TagFieldValue: undefined as typeof TagFieldModule.TagFieldValue | undefined,
}));

vi.mock('@/lib/tagFieldValue', () => ({
	get TagFieldValue() {
		return binding.TagFieldValue;
	},
}));

it('mounts when the tag class initializes after the project module', async () => {
	// A production chunk cycle can evaluate the schema before the class assignment.
	const actual = await vi.importActual<typeof TagFieldModule>('@/lib/tagFieldValue');
	binding.TagFieldValue = actual.TagFieldValue;
	makeFetch({ project: { tags: ['sales'] } });
	await renderProject();
	expect(screen.getByRole('heading', { name: 'Sales' })).toBeVisible();
});
