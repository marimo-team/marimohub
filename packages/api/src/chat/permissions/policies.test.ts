import { describe, expect, it } from 'vitest';
import { CHAT_LIMITS } from '@marimo-hub/core/chat';
import { isGated, oversizedDetail, permissionRequest } from './policies';

describe('consent policies', () => {
	it('gates every tool that is not read-only', () => {
		expect(isGated({ name: 'list_catalog', annotations: { readOnlyHint: true } })).toBe(false);
		expect(isGated({ name: 'create_notebook' })).toBe(true);
		expect(
			permissionRequest({ name: 'get_notebook', annotations: { readOnlyHint: true } }, {}),
		).toBe(undefined);
	});

	it('shows the code a user is asked to approve, in full up to the cap', () => {
		const code = 'x'.repeat(CHAT_LIMITS.consentDetailCharacters);
		const request = permissionRequest(
			{ name: 'execute_code' },
			{ session_id: 'sess-1', code, project: 'p' },
		)!;
		expect(request.action).toBe('Run code in a notebook session');
		expect(request.details).toEqual([
			{ label: 'Session', value: 'sess-1' },
			{ label: 'Code', value: code },
		]);
		expect(request.can_remember).toBe(false);
		expect(
			oversizedDetail({ name: 'execute_code' }, { session_id: 'sess-1', code }),
		).toBeUndefined();
	});

	it('refuses code that exceeds the card limit rather than showing part of it', () => {
		const code = 'x'.repeat(CHAT_LIMITS.consentDetailCharacters + 1);
		expect(oversizedDetail({ name: 'create_notebook' }, { title: 'T', code })).toEqual({
			label: 'Code',
			limit: CHAT_LIMITS.consentDetailCharacters,
		});
		expect(oversizedDetail({ name: 'update_notebook' }, { notebook: 'n', readme: code })).toEqual({
			label: 'Readme',
			limit: CHAT_LIMITS.consentDetailCharacters,
		});
		// Read-only tools and short fields are never refused; long short fields are marked.
		expect(
			oversizedDetail({ name: 'get_notebook', annotations: { readOnlyHint: true } }, { code }),
		).toBeUndefined();
		expect(
			oversizedDetail({ name: 'create_notebook' }, { title: 'x'.repeat(5000) }),
		).toBeUndefined();
		const shown = permissionRequest({ name: 'create_notebook' }, { title: 'x'.repeat(5000) })!;
		expect(shown.details[0].value.endsWith('[truncated]')).toBe(true);
	});

	it('shows every side effect of creating or changing a notebook', () => {
		const create = permissionRequest(
			{ name: 'create_notebook' },
			{ title: 'T', code: 'import marimo', readme: '# Hi', launch: true, project: 'p' },
		)!;
		expect(create.details.map((d) => [d.label, d.value])).toEqual([
			['Title', 'T'],
			['Readme', '# Hi'],
			['Code', 'import marimo'],
			['Start a session', 'true'],
		]);
		const stop = permissionRequest({ name: 'stop_session' }, { session_id: 'sess-9' })!;
		expect(stop.details).toEqual([{ label: 'Session', value: 'sess-9' }]);
	});

	it('shows the fields each hub tool actually accepts, rendering structured values', () => {
		const update = permissionRequest(
			{ name: 'update_notebook' },
			{ project: 'p', notebook: 'nb', description: 'd', tags: ['a', 'b'], message: 'bump' },
		)!;
		expect(update.details.map((d) => d.label)).toEqual([
			'Notebook',
			'Description',
			'Tags',
			'Version message',
		]);
		expect(JSON.parse(update.details[2].value)).toEqual(['a', 'b']);
		const readme = permissionRequest(
			{ name: 'update_notebook' },
			{ notebook: 'nb', readme: '# Docs' },
		)!;
		expect(readme.details.map((d) => d.label)).toEqual(['Notebook', 'Readme']);
		const schedule = permissionRequest(
			{ name: 'schedule_job' },
			{ job: 'nightly', schedule: { cron: '0 6 * * *', timezone: 'UTC' }, enabled: false },
		)!;
		expect(schedule.details.map((d) => d.label)).toEqual(['Job', 'Schedule', 'Enabled']);
		expect(schedule.details[1].value).toContain('0 6 * * *');
		expect(schedule.details[2].value).toBe('false');
		const run = permissionRequest({ name: 'run_job' }, { job: 'j', parameters: { day: '1' } })!;
		expect(run.details.map((d) => d.label)).toEqual(['Job', 'Parameters']);
	});

	it('shows the repository subtree and complete PR body before approval', () => {
		const create = permissionRequest(
			{ name: 'create_branch_notebook' },
			{
				repo: 'owner/repo',
				base_branch: 'main',
				root_path: 'apps/finance',
				entry_notebook: 'app.py',
			},
		)!;
		expect(create.details).toContainEqual({ label: 'Root path', value: 'apps/finance' });
		const body = 'x'.repeat(CHAT_LIMITS.consentDetailCharacters);
		const tool = { name: 'open_change_request' };
		expect(permissionRequest(tool, { body })!.details).toContainEqual({
			label: 'Body',
			value: body,
		});
		expect(oversizedDetail(tool, { body })).toBeUndefined();
		expect(oversizedDetail(tool, { body: `${body}x` })).toEqual({
			label: 'Body',
			limit: CHAT_LIMITS.consentDetailCharacters,
		});
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

	it('describes unknown tools from their inputs without the project', () => {
		const request = permissionRequest(
			{ name: 'ship_it' },
			{ project: 'p', target: 'prod', count: 3, nested: { a: 1 }, flag: true, empty: '' },
		)!;
		expect(request.action).toBe('Run ship it');
		expect(request.details).toEqual([
			{ label: 'target', value: 'prod' },
			{ label: 'count', value: '3' },
			{ label: 'nested', value: '{\n  "a": 1\n}' },
			{ label: 'flag', value: 'true' },
		]);
		expect(request.can_remember).toBe(true);
	});

	it('keeps every text within the stored limits', () => {
		const request = permissionRequest(
			{ name: 'x'.repeat(300) },
			{ ['k'.repeat(100)]: 'v'.repeat(3000) },
		)!;
		expect(request.action.length).toBeLessThanOrEqual(120);
		expect(request.scope.key.length).toBeLessThanOrEqual(200);
		expect(request.scope.label.length).toBeLessThanOrEqual(120);
		expect(request.details[0].label.length).toBeLessThanOrEqual(40);
		expect(request.details[0].value.length).toBe(2000);
		expect(request.details[0].value.endsWith('[truncated]')).toBe(true);
	});
});
