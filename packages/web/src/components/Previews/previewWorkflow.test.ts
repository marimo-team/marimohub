import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { PREVIEW_ACTION_REF, previewWorkflow } from './previewWorkflow';

describe('preview workflow', () => {
	it('generates PR events, scoped permissions, and queued concurrency without a checkout', () => {
		const workflow = parse(
			previewWorkflow({
				hubUrl: 'https://hub.example.com',
				projectId: 'proj',
				notebookId: 'nb',
				mode: 'sticky',
				keep: 5,
				eager: true,
			}),
		);
		expect(workflow.on.pull_request.types).toEqual(['opened', 'reopened', 'synchronize', 'closed']);
		expect(workflow.permissions).toEqual({ actions: 'read', 'pull-requests': 'write' });
		expect(workflow.concurrency).toEqual({
			group: 'marimo-preview-${{ github.event.pull_request.number }}',
			queue: 'max',
			'cancel-in-progress': false,
		});
		expect(workflow.jobs.preview.steps).toHaveLength(1);
		expect(PREVIEW_ACTION_REF).toMatch(/^[a-f0-9]{40}$/);
		expect(workflow.jobs.preview.steps[0].uses).toBe(
			`marimo-team/marimohub/actions/preview@${PREVIEW_ACTION_REF}`,
		);
		expect(workflow.jobs.preview.steps[0].with).toMatchObject({
			mode: 'sticky',
			eager: 'true',
			keep: '5',
			'hub-token': '${{ secrets.MARIMOHUB_TOKEN }}',
		});
	});
	it('preserves quotes and emits optional inactivity', () => {
		const workflow = parse(
			previewWorkflow({
				hubUrl: "https://hub.example.com/a'b",
				projectId: 'proj',
				notebookId: 'nb',
				mode: 'commits',
				keep: 3,
				eager: false,
				idle_days: 2,
			}),
		);
		expect(workflow.jobs.preview.steps[0].with).toMatchObject({
			'hub-url': "https://hub.example.com/a'b",
			mode: 'commits',
			eager: 'false',
			'idle-days': '2',
		});
	});
});
