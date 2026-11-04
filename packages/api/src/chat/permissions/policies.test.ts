import { describe, expect, it } from 'vitest';
import { isGated, permissionRequest } from './policies';

describe('consent policies', () => {
	it('gates every tool that is not read-only', () => {
		expect(isGated({ name: 'list_catalog', annotations: { readOnlyHint: true } })).toBe(false);
		expect(isGated({ name: 'create_notebook' })).toBe(true);
		expect(
			permissionRequest({ name: 'get_notebook', annotations: { readOnlyHint: true } }, {}),
		).toBe(undefined);
	});

	it('shows the code a user is asked to approve, in full up to the cap', () => {
		const code = 'import marimo\n'.repeat(400);
		const request = permissionRequest(
			{ name: 'execute_code' },
			{ notebook: 'Sales', code, project: 'p' },
		)!;
		expect(request.action).toBe('Run code in a notebook session');
		expect(request.details.map((d) => d.label)).toEqual(['Notebook', 'Code']);
		expect(request.details[1].value.length).toBe(4000);
		expect(request.can_remember).toBe(false);
	});

	it('never remembers destructive actions and remembers routine ones', () => {
		expect(
			permissionRequest(
				{ name: 'delete_notebook', annotations: { destructiveHint: true, idempotentHint: true } },
				{ notebook: 'Old' },
			)!.can_remember,
		).toBe(false);
		expect(
			permissionRequest({ name: 'update_notebook', annotations: { destructiveHint: true } }, {})!
				.can_remember,
		).toBe(false);
		const create = permissionRequest({ name: 'create_notebook' }, { title: 'New' })!;
		expect(create.can_remember).toBe(true);
		expect(create.scope).toEqual({
			key: 'tool:create_notebook',
			label: 'creating notebooks in this project',
		});
	});

	it('describes unknown tools from their scalar inputs without the project', () => {
		const request = permissionRequest(
			{ name: 'ship_it' },
			{ project: 'p', target: 'prod', count: 3, nested: { a: 1 }, flag: true, empty: '' },
		)!;
		expect(request.action).toBe('Run ship it');
		expect(request.details).toEqual([
			{ label: 'target', value: 'prod' },
			{ label: 'count', value: '3' },
			{ label: 'flag', value: 'true' },
		]);
		expect(request.can_remember).toBe(true);
	});

	it('keeps every text within the stored limits', () => {
		const request = permissionRequest(
			{ name: 'x'.repeat(300) },
			{ ['k'.repeat(100)]: 'v'.repeat(1000) },
		)!;
		expect(request.action.length).toBeLessThanOrEqual(120);
		expect(request.scope.key.length).toBeLessThanOrEqual(200);
		expect(request.scope.label.length).toBeLessThanOrEqual(120);
		expect(request.details[0].value.length).toBe(300);
	});
});
