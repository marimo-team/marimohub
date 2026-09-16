import { afterEach, expect, it, vi } from 'vitest';
import { BUCKET_SCAN_CONCURRENCY } from '@marimo-hub/core';
import { ACTOR, localResourceSecurity, makeSubjectContext } from '@marimo-hub/core/testing';
import { createTestApi, expectPage } from '../testing';

afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
	'bounds gallery work across projects (legacy labels: %s)',
	async (legacy) => {
		const security = localResourceSecurity(['SECRET'], makeSubjectContext());
		const { deps, request } = createTestApi({ deps: { resourceSecurity: security } });
		await deps.services.catalog.initialize(ACTOR);
		const count = BUCKET_SCAN_CONCURRENCY + 1;
		for (let p = 0; p < 3; p++) {
			const project = await deps.services.projects.createProject(
				{ name: `P${p}`, description: '' },
				ACTOR,
			);
			for (let n = 0; n < count; n++) {
				const notebook = await deps.services.notebooks.createNotebook(
					project.id,
					{
						title: `N${n}`,
						description: '',
						code: 'pass',
					},
					ACTOR,
				);
				await deps.services.notebooks.setSecurityLabels(
					project.id,
					notebook.id,
					{
						classification: 'SECRET',
						compartments: [],
					},
					ACTOR,
				);
				if (legacy)
					await deps.services.catalog.updateNotebookEntry(
						'test.legacy',
						ACTOR,
						project.id,
						notebook.id,
						() => ({ security_labels: undefined }),
					);
			}
		}

		let active = 0;
		let maximum = 0;
		async function measured<T>(work: () => Promise<T>): Promise<T> {
			maximum = Math.max(maximum, ++active);
			try {
				await new Promise((resolve) => setTimeout(resolve, 1));
				return await work();
			} finally {
				active--;
			}
		}
		const notebooks = deps.services.notebooks;
		const read = notebooks.getSecurityLabels.bind(notebooks);
		vi.spyOn(notebooks, 'getSecurityLabels').mockImplementation((...args) =>
			measured(() => read(...args)),
		);
		vi.spyOn(security.constraints, 'evaluate').mockImplementation(() =>
			measured(async () => ({ satisfied: true })),
		);
		vi.spyOn(security.constraints, 'evaluateMany').mockImplementation(
			(_context, _action, resources) =>
				measured(async () => resources.map(() => ({ satisfied: true }))),
		);

		expect(await expectPage(await request('GET', '/apps?limit=100'))).toHaveLength(3 * count);
		expect(maximum).toBeGreaterThan(1);
		expect(maximum).toBeLessThanOrEqual(BUCKET_SCAN_CONCURRENCY);
		expect(active).toBe(0);
	},
);
