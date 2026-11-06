import { describe, expect, it } from 'vitest';
import { applyPreviewEvent, automationName, PreviewReconcileSchema } from './previewAutomation';
import type { PreviewAutomationGroup, PreviewReconcile } from './previewAutomation';
import { ConflictError } from '../../errors';
import { PreviewIntentSchema, PreviewRecordSchema, previewExpired } from './notebookPreviews';
import { createNotebookId, createPreviewId, createProjectId } from '../../ids';
import { ACTOR } from '../../testing/fixtures';

describe('preview automation names and compatibility', () => {
	it('preserves branch names and suffixes within the name limit', () => {
		const hash = 'a'.repeat(64);
		const commit = 'b'.repeat(40);
		expect(automationName('feature/chart', hash)).toBe('feature/chart');
		expect(automationName('feature/chart', hash, commit)).toBe('feature/chart-bbbbbbbbbbbb');
		const long = automationName('feature/'.repeat(30), hash, commit);
		expect(long).toHaveLength(100);
		expect(long).toMatch(/-aaaaaaaaaaaa-bbbbbbbbbbbb$/);
		expect(automationName('feature/'.repeat(30), 'c'.repeat(64), commit)).not.toBe(long);
	});

	it('reads old records with their finite expiry and implicit eager behavior', () => {
		const record = PreviewRecordSchema.parse({
			schema_version: 1,
			id: createPreviewId(),
			project_id: createProjectId(),
			notebook_id: createNotebookId(),
			name: 'Existing',
			source: { type: 'commit', commit: 'a'.repeat(40) },
			repository: 'owner/repo',
			root_path: '',
			entry_notebook: 'notebook.py',
			created_by: ACTOR,
			created_at: new Date().toISOString(),
			expires_at: new Date(Date.now() + 86400000).toISOString(),
			request_fingerprint: 'existing',
			state: 'active',
			preparation: 'pending',
			revisions: [],
		});
		expect(record.eager).toBeUndefined();
		expect(record.automation).toBeUndefined();
		expect(previewExpired(record)).toBe(false);
		expect(previewExpired({ expires_at: '2000-01-01T00:00:00.000Z' })).toBe(true);
		expect(previewExpired({ expires_at: null })).toBe(false);
	});
	it.each(['requested_commit', 'observed_commit'] as const)(
		'validates persisted %s as a full commit SHA',
		(field) => {
			const schema = PreviewRecordSchema.shape[field];
			for (const value of ['a'.repeat(40), 'ABCDEF0123'.repeat(4), undefined])
				expect(schema.safeParse(value).success).toBe(true);
			for (const value of [
				'',
				'a'.repeat(12),
				'a'.repeat(41),
				'g'.repeat(40),
				`${'a'.repeat(39)}\n`,
			])
				expect(schema.safeParse(value).success).toBe(false);
		},
	);
});

const FIRST = 'a'.repeat(40);
const SECOND = 'b'.repeat(40);
const THIRD = 'c'.repeat(40);
const BRANCH = 'feature/chart';
const BRANCH_HASH = 'd'.repeat(64);
const CREATED_AT = '2026-11-01T00:00:00.000Z';

function event(
	order: number,
	commit = FIRST,
	policy: Partial<PreviewReconcile['policy']> = {},
	action: PreviewReconcile['event'] = 'synchronize',
): PreviewReconcile {
	return PreviewReconcileSchema.parse({
		repository: 'owner/repo',
		pull_request: 42,
		event: action,
		commit,
		workflow_id: '10',
		run_id: String(order),
		run_number: order,
		event_at: new Date(Date.parse(CREATED_AT) + order * 60_000).toISOString(),
		policy,
	});
}

function fixture() {
	const base = PreviewIntentSchema.parse({
		schema_version: 1,
		id: createPreviewId(),
		project_id: createProjectId(),
		notebook_id: createNotebookId(),
		name: BRANCH,
		source: { type: 'commit', commit: FIRST },
		repository: 'owner/repo',
		root_path: '',
		entry_notebook: 'notebook.py',
		pull_request: 42,
		created_by: ACTOR,
		created_at: CREATED_AT,
		expires_at: null,
		request_fingerprint: 'pr-group',
		state: 'active',
	});
	return (previous: PreviewAutomationGroup | undefined, input: PreviewReconcile) =>
		applyPreviewEvent(
			previous,
			input,
			{
				...base,
				source: { type: 'commit', commit: input.commit },
				created_at: input.event_at,
				eager: input.policy.eager,
				automation: { key: 'pr-group', revision: 0, commit: input.commit },
			},
			BRANCH,
			BRANCH_HASH,
		);
}

function retained(group: PreviewAutomationGroup) {
	return group.heads.map(({ commit, order, intent }) => ({ commit, order, id: intent.id }));
}

function generation(group: PreviewAutomationGroup, commit = group.head) {
	return group.heads.find((head) => head.commit === commit)?.intent.automation?.generation;
}

describe('applyPreviewEvent', () => {
	it('converges duplicate updates from the same snapshot without changing the sticky identity', () => {
		const apply = fixture();
		const first = apply(undefined, event(1));
		const snapshot = structuredClone(first);
		const update = event(2, SECOND);
		const left = apply(first, update);
		const right = apply(first, update);
		expect(left).toEqual(right);
		expect(apply(left, update)).toBe(left);
		expect(apply(right, update)).toBe(right);
		expect(left.heads[0].intent.id).toBe(first.heads[0].intent.id);
		expect(left.heads[0].intent.automation?.commit).toBe(SECOND);
		expect(first).toEqual(snapshot);
	});

	it('inserts delayed heads by original order without rolling back current policy', () => {
		const apply = fixture();
		const policy = { mode: 'commits' as const, keep: 2, eager: false };
		const first = apply(undefined, event(1, FIRST, policy));
		const newest = apply(first, event(3, THIRD, policy));
		const delayed = apply(newest, event(2, SECOND, { mode: 'sticky', eager: true }));
		expect(delayed.policy).toEqual(newest.policy);
		expect(delayed.head).toBe(THIRD);
		expect(delayed.run_number).toBe(3);
		expect(
			delayed.heads.map(({ commit, order, intent }) => ({
				commit,
				order,
				name: intent.name,
				eager: intent.eager,
			})),
		).toEqual([
			{ commit: THIRD, order: 3, name: `${BRANCH}-${THIRD.slice(0, 12)}`, eager: false },
			{ commit: SECOND, order: 2, name: `${BRANCH}-${SECOND.slice(0, 12)}`, eager: false },
		]);
		expect(delayed.floor).toBe(1);
		expect(apply(delayed, event(1, FIRST, policy))).toBe(delayed);
		expect(generation(delayed, THIRD)).toBe(generation(newest, THIRD));
	});

	it('does not backfill evicted heads when retention increases', () => {
		const apply = fixture();
		const policy = { mode: 'commits' as const, keep: 1 };
		const first = apply(undefined, event(1, FIRST, policy));
		const second = apply(first, event(2, SECOND, policy));
		const expanded = apply(second, event(3, SECOND, { ...policy, keep: 3 }));
		expect(expanded.heads).toHaveLength(1);
		expect(expanded.heads[0].intent.id).toBe(second.heads[0].intent.id);
		expect(expanded.floor).toBe(1);
		expect(apply(expanded, event(1, FIRST, policy))).toBe(expanded);
	});

	it('replaces the managed set when modes change and fences the previous mode', () => {
		const apply = fixture();
		const sticky = apply(undefined, event(1));
		const commits = apply(sticky, event(2, SECOND, { mode: 'commits' }));
		expect(commits.heads).toHaveLength(1);
		expect(commits.heads[0].intent).toMatchObject({
			name: `${BRANCH}-${SECOND.slice(0, 12)}`,
			source: { type: 'commit', commit: SECOND },
		});
		expect(commits.heads[0].intent.id).not.toBe(sticky.heads[0].intent.id);
		const resumed = apply(commits, event(3, THIRD));
		expect(resumed.heads).toHaveLength(1);
		expect(resumed.heads[0].intent).toMatchObject({
			name: BRANCH,
			source: { type: 'branch', branch: BRANCH },
		});
		expect(resumed.heads[0].intent.id).not.toBe(commits.heads[0].intent.id);
		expect(resumed.floor).toBe(2);
		expect(apply(resumed, event(2, SECOND, { mode: 'commits' }))).toBe(resumed);
	});

	it('preserves retained demand generations across other heads and lifetime or retention changes', () => {
		const apply = fixture();
		const policy = { mode: 'commits' as const, eager: false };
		const first = apply(undefined, event(1, FIRST, policy));
		expect(generation(first, FIRST)).toBeDefined();
		const second = apply(first, event(2, SECOND, policy));
		expect(generation(second, FIRST)).toBe(generation(first, FIRST));
		const changedPolicy = apply(second, event(3, SECOND, { ...policy, keep: 3, idle_days: 2 }));
		for (const commit of [FIRST, SECOND])
			expect(generation(changedPolicy, commit)).toBe(generation(second, commit));
		expect(changedPolicy.heads.map(({ intent }) => intent.expires_at)).toEqual([
			'2026-11-03T00:02:00.000Z',
			'2026-11-03T00:02:00.000Z',
		]);
		const eager = apply(changedPolicy, event(4, SECOND, { ...policy, eager: true }));
		for (const commit of [FIRST, SECOND])
			expect(generation(eager, commit)).toBeGreaterThan(generation(changedPolicy, commit)!);
	});

	it('changes the sticky demand generation only when the head or eager policy changes', () => {
		const apply = fixture();
		const first = apply(undefined, event(1, FIRST, { eager: false }));
		expect(generation(first)).toBeDefined();
		const policyOnly = apply(first, event(2, FIRST, { eager: false, idle_days: 1 }));
		expect(generation(policyOnly)).toBe(generation(first));
		const pushed = apply(policyOnly, event(3, SECOND, { eager: false, idle_days: 1 }));
		expect(pushed.heads[0].intent.id).toBe(first.heads[0].intent.id);
		expect(generation(pushed)).toBeGreaterThan(generation(policyOnly)!);
		const eager = apply(pushed, event(4, SECOND, { eager: true }));
		expect(generation(eager)).toBeGreaterThan(generation(pushed)!);
	});

	it('preserves a legacy demand generation when only policy metadata changes', () => {
		const apply = fixture();
		const legacy = apply(undefined, event(1, FIRST, { eager: false }));
		delete legacy.heads[0].intent.automation!.generation;
		const updated = apply(legacy, event(2, FIRST, { eager: false, idle_days: 1 }));
		expect(generation(updated)).toBe(legacy.heads[0].intent.automation!.revision);
		const pushed = apply(updated, event(3, SECOND, { eager: false, idle_days: 1 }));
		expect(generation(pushed)).toBeGreaterThan(generation(updated)!);
	});

	it('reuses a retained commit after a force push without renewing inactivity for reruns', () => {
		const apply = fixture();
		const policy = { mode: 'commits' as const, keep: 2, idle_days: 1 };
		const first = apply(undefined, event(1, FIRST, policy));
		const second = apply(first, event(2, SECOND, policy));
		const forced = apply(second, event(3, FIRST, policy));
		expect(retained(forced)).toEqual([
			{ commit: FIRST, order: 3, id: first.heads[0].intent.id },
			{ commit: SECOND, order: 2, id: second.heads[0].intent.id },
		]);
		expect(generation(forced, FIRST)).toBe(generation(first, FIRST));
		expect(forced.last_commit_at).toBe(event(3).event_at);
		const rerun = apply(forced, { ...event(3, FIRST, policy), event_at: event(4).event_at });
		expect(rerun).toBe(forced);
		const sameHead = apply(forced, event(4, FIRST, policy));
		expect(sameHead.last_commit_at).toBe(forced.last_commit_at);
		expect(generation(sameHead, FIRST)).toBe(generation(forced, FIRST));
	});

	it('creates a fresh reopen lifecycle while delayed close and push events stay fenced', () => {
		const apply = fixture();
		const first = apply(undefined, event(1));
		const closed = apply(first, event(2, FIRST, {}, 'closed'));
		expect(closed).toMatchObject({ state: 'closed', floor: 2, heads: [] });
		expect(apply(closed, event(1))).toBe(closed);
		expect(apply(closed, event(2, FIRST, {}, 'closed'))).toBe(closed);
		const reopened = apply(closed, event(4, SECOND, {}, 'reopened'));
		expect(reopened.state).toBe('active');
		expect(reopened.heads[0].intent.id).not.toBe(first.heads[0].intent.id);
		expect(reopened.heads[0].intent.automation?.commit).toBe(SECOND);
		expect(apply(reopened, event(2, FIRST, {}, 'closed'))).toBe(reopened);
		expect(apply(reopened, event(3))).toBe(reopened);
	});

	it('accepts a current synchronize before the reopen event without replacing its head', () => {
		const apply = fixture();
		const closed = apply(apply(undefined, event(1)), event(2, FIRST, {}, 'closed'));
		const pushed = apply(closed, event(4, SECOND));
		expect(pushed.state).toBe('active');
		expect(apply(pushed, event(3, FIRST, {}, 'reopened'))).toBe(pushed);
	});

	it('advances the replay fence for a newer close even when already retired', () => {
		const apply = fixture();
		const closed = apply(apply(undefined, event(1)), event(2, FIRST, {}, 'closed'));
		const closedAgain = apply(closed, event(4, SECOND, {}, 'closed'));
		expect(closedAgain).toMatchObject({ state: 'closed', run_number: 4, floor: 4, heads: [] });
		expect(apply(closedAgain, event(3, SECOND, {}, 'reopened'))).toBe(closedAgain);
		expect(apply(closedAgain, event(3, SECOND))).toBe(closedAgain);
		expect(apply(closedAgain, event(5, THIRD, {}, 'reopened'))).toMatchObject({
			state: 'active',
			head: THIRD,
		});
	});

	it.each(['workflow', 'run', 'commit'] as const)(
		'rejects conflicting %s identity without changing the group',
		(conflict) => {
			const apply = fixture();
			const current = apply(undefined, event(1));
			const snapshot = structuredClone(current);
			const conflicting = {
				...event(1),
				...(conflict === 'workflow'
					? { workflow_id: '20' }
					: conflict === 'run'
						? { run_id: '99' }
						: { commit: SECOND }),
			};
			expect(() => apply(current, conflicting)).toThrow(ConflictError);
			expect(current).toEqual(snapshot);
		},
	);
});
