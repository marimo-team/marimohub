import { describe, expect, it } from 'vitest';
import { createJobId, createNotebookId, createProjectId, createRunId } from '../../ids';
import { JobRunSchema, RUN_STATUSES } from '../../schema';
import { ACTOR, uid } from '../../testing/fixtures';
import { jobCapabilities, MAX_ACTIVE_CONSUMER_RUNS_PER_JOB, toSharedJobRunSummary } from './access';

const OTHER = uid('other');

describe('job capabilities', () => {
	it.each(['private', 'shared'] as const)(
		'keeps execution independent of %s history',
		(history) => {
			for (const execution of [false, true]) {
				for (const triggerAllowed of [false, true]) {
					const access = jobCapabilities({
						job: { consumer_execution: execution, consumer_history: history },
						userId: ACTOR,
						editor: false,
						triggerAllowed,
						run: { triggered_by: OTHER },
					});
					expect(access).toEqual({
						editor: false,
						canTrigger: execution && triggerAllowed,
						history: history === 'shared' ? 'summary' : 'none',
						canReadHtml: false,
						canReadLogs: false,
					});
				}
			}
		},
	);

	it('gives owners full history and HTML without log or trigger authority', () => {
		expect(
			jobCapabilities({
				job: {},
				userId: ACTOR,
				editor: false,
				triggerAllowed: true,
				run: { triggered_by: ACTOR },
			}),
		).toEqual({
			editor: false,
			canTrigger: false,
			history: 'full',
			canReadHtml: true,
			canReadLogs: false,
		});
	});

	it('preserves editor access independently of consumer policy and trigger grants', () => {
		expect(
			jobCapabilities({
				job: {},
				userId: ACTOR,
				editor: true,
				triggerAllowed: false,
				run: { triggered_by: OTHER },
			}),
		).toEqual({
			editor: true,
			canTrigger: true,
			history: 'full',
			canReadHtml: true,
			canReadLogs: true,
		});
	});

	it('does not treat scheduled runs as consumer-owned', () => {
		expect(
			jobCapabilities({
				job: {},
				userId: ACTOR,
				editor: false,
				triggerAllowed: true,
				run: {},
			}).history,
		).toBe('none');
	});
});

describe('consumer run cap', () => {
	it('is a small fixed bound that lets a consumer keep a few runs in flight', () => {
		expect(MAX_ACTIVE_CONSUMER_RUNS_PER_JOB).toBe(3);
	});
});

describe('shared run summary', () => {
	it.each(RUN_STATUSES)('explicitly projects permitted fields for %s runs', (status) => {
		const run = JobRunSchema.parse({
			schema_version: 1,
			run_id: createRunId(),
			job_id: createJobId(),
			notebook_id: createNotebookId(),
			project_id: createProjectId(),
			status,
			trigger: 'manual',
			triggered_by: ACTOR,
			attempt: 1,
			timeout_seconds: 60,
			queued_at: '2026-01-01T00:00:00.000Z',
			tags: { app: 'forecast' },
			parameters: { region: 'eu' },
			image: 'private-image',
			compute_profile: 'private-profile',
			compute_resources: { cpu: 2 },
			exit_code: 1,
			error: { code: 'FAILED', message: 'owner diagnostics' },
			output: { html_bytes: 100, logs_bytes: 100 },
			future_diagnostic: 'must stay private',
		});
		const active = ['queued', 'provisioning', 'running'].includes(status);
		expect(JSON.parse(JSON.stringify(toSharedJobRunSummary(run)))).toEqual({
			run_id: run.run_id,
			job_id: run.job_id,
			notebook_id: run.notebook_id,
			project_id: run.project_id,
			status,
			trigger: 'manual',
			triggered_by: ACTOR,
			attempt: 1,
			timeout_seconds: 60,
			queued_at: run.queued_at,
			tags: { app: 'forecast' },
			...(!active ? { parameters: { region: 'eu' } } : {}),
		});
	});
});
