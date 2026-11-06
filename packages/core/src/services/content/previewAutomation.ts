import { PreviewAutomationPolicySchema } from '../../previewPolicy';
export { PreviewAutomationPolicySchema } from '../../previewPolicy';
import { z } from 'zod';
import { utcTimestamp } from '../../stringFormats';
import { NotebookIdSchema, UserIdSchema } from '../../schema';
import { createPreviewId } from '../../ids';
import { ConflictError } from '../../errors';
import { PreviewIntentSchema } from './notebookPreviews';
import type { PreviewIntent } from './notebookPreviews';

export const PreviewReconcileSchema = z.strictObject({
	repository: z.string().min(1).max(500),
	pull_request: z.number().int().positive(),
	event: z.enum(['opened', 'reopened', 'synchronize', 'closed']),
	commit: z.string().regex(/^[a-f0-9]{40}$/),
	workflow_id: z.string().regex(/^\d+$/),
	run_id: z.string().regex(/^\d+$/),
	run_number: z.number().int().positive(),
	event_at: utcTimestamp(),
	policy: PreviewAutomationPolicySchema,
});
export type PreviewReconcile = z.infer<typeof PreviewReconcileSchema>;
export const PreviewAutomationGroupSchema = z.object({
	key: z.string(),
	notebook_id: NotebookIdSchema,
	repository: z.string(),
	pull_request: z.number().int().positive(),
	workflow_id: z.string(),
	run_number: z.number(),
	run_id: z.string(),
	floor: z.number(),
	revision: z.number(),
	state: z.enum(['active', 'closed', 'expired']),
	head: z.string(),
	last_commit_at: utcTimestamp(),
	policy: PreviewAutomationPolicySchema,
	created_by: UserIdSchema,
	checked_at: z.number().optional(),
	heads: z.array(z.object({ commit: z.string(), order: z.number(), intent: PreviewIntentSchema })),
});
export type PreviewAutomationGroup = z.infer<typeof PreviewAutomationGroupSchema>;

export function automationName(branch: string, hash: string, commit?: string): string {
	const suffix = commit ? `-${commit.slice(0, 12)}` : '';
	const available = 100 - suffix.length;
	return (
		(branch.length <= available
			? branch
			: `${branch.slice(0, available - 13)}-${hash.slice(0, 12)}`) + suffix
	);
}

export function automationExpiresAt(group: PreviewAutomationGroup): string | null {
	return group.policy.idle_days
		? new Date(Date.parse(group.last_commit_at) + group.policy.idle_days * 86_400_000).toISOString()
		: null;
}

export function retireAutomationGroup(
	group: PreviewAutomationGroup,
	state: 'closed' | 'expired',
): void {
	group.state = state;
	group.floor = group.run_number;
	group.heads = [];
	group.revision++;
}

export function applyPreviewEvent(
	previous: PreviewAutomationGroup | undefined,
	input: PreviewReconcile,
	template: PreviewIntent,
	branch: string,
	branchHash: string,
): PreviewAutomationGroup {
	if (previous && previous.workflow_id !== input.workflow_id)
		throw new ConflictError('This PR preview is managed by another workflow');
	if (previous && input.run_number === previous.run_number && input.run_id !== previous.run_id)
		throw new ConflictError('Workflow run number already used');
	const recordedHead = previous?.heads.find((head) => head.order === input.run_number);
	if (recordedHead && recordedHead.commit !== input.commit)
		throw new ConflictError('Workflow run already used for another commit');
	if (previous && (input.run_number <= previous.floor || input.run_number === previous.run_number))
		return previous;
	const newest = !previous || input.run_number > previous.run_number;
	// Live PR state is checked by the caller; synchronize can arrive before reopened.
	if (previous?.state !== undefined && previous.state !== 'active') {
		const resume =
			newest &&
			(input.event === 'reopened' ||
				(previous.state === 'closed' && input.event === 'synchronize') ||
				(previous.state === 'expired' &&
					input.event === 'synchronize' &&
					input.commit !== previous.head));
		if (!resume && !(newest && input.event === 'closed')) return previous;
	}
	if (
		!newest &&
		((input.event !== 'synchronize' && !(input.event === 'opened' && previous?.floor === 0)) ||
			previous?.policy.mode !== 'commits')
	)
		return previous;
	const restarting = previous && previous.state !== 'active';
	const group: PreviewAutomationGroup = previous
		? structuredClone(previous)
		: {
				key: template.automation!.key,
				notebook_id: template.notebook_id,
				repository: template.repository,
				pull_request: input.pull_request,
				workflow_id: input.workflow_id,
				run_id: input.run_id,
				run_number: input.run_number,
				floor: 0,
				revision: 0,
				state: 'active',
				head: input.commit,
				last_commit_at: input.event_at,
				policy: input.policy,
				created_by: template.created_by,
				heads: [],
			};
	if (restarting || (newest && group.policy.mode !== input.policy.mode)) {
		group.floor = group.run_number;
		group.heads = [];
	}
	if (newest) {
		if (input.commit !== group.head || restarting) group.last_commit_at = input.event_at;
		group.head = input.commit;
		group.run_number = input.run_number;
		group.run_id = input.run_id;
		group.policy = input.policy;
		group.state = input.event === 'closed' ? 'closed' : 'active';
	}
	if (group.state === 'closed') {
		retireAutomationGroup(group, 'closed');
		return group;
	}
	group.revision++;
	const existing =
		group.policy.mode === 'sticky'
			? group.heads[0]
			: group.heads.find((h) => h.commit === input.commit);
	if (existing) {
		existing.order = Math.max(existing.order, input.run_number);
		if (newest && group.policy.mode === 'sticky') existing.commit = input.commit;
	} else {
		group.heads.push({
			commit: input.commit,
			order: input.run_number,
			intent: { ...template, id: createPreviewId() },
		});
	}
	group.heads.sort((a, b) => b.order - a.order);
	const removed = group.heads.splice(group.policy.mode === 'sticky' ? 1 : group.policy.keep);
	for (const head of removed) group.floor = Math.max(group.floor, head.order);
	for (const head of group.heads) {
		const sticky = group.policy.mode === 'sticky';
		const previousTarget = head.intent.automation;
		const generation =
			previousTarget?.commit === head.commit && head.intent.eager === group.policy.eager
				? (previousTarget.generation ?? previousTarget.revision)
				: group.revision;
		head.intent = {
			...head.intent,
			name: automationName(branch, branchHash, sticky ? undefined : head.commit),
			source: sticky ? { type: 'branch', branch } : { type: 'commit', commit: head.commit },
			eager: group.policy.eager,
			expires_at: automationExpiresAt(group),
			automation: { key: group.key, revision: group.revision, generation, commit: head.commit },
		};
	}
	return group;
}
