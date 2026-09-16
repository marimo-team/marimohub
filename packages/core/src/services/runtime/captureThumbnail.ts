import { z } from 'zod';
import type { SandboxInstance } from '../../ports/sandbox';
import type { NotebookService } from '../content/NotebookService';
import type { ProjectId, NotebookId } from '../../ids';
import { logEvent } from '../../logs';
import { shellQuote } from './shell';
import { THUMBNAIL_MAX_BYTES } from '../content/thumbnailPng';
import { THUMBNAIL_PROGRAM } from './thumbnailProgram';

export const THUMBNAIL_MAINTENANCE_BUDGET_MS = 3000;

const CaptureResponseSchema = z.object({
	status: z.enum([
		'ok',
		'missing_playwright',
		'missing_chromium',
		'missing_marimo',
		'render_failed',
		'timeout',
		'insufficient_budget',
	]),
	png: z
		.string()
		.max(Math.ceil(THUMBNAIL_MAX_BYTES / 3) * 4)
		.optional(),
});

export async function captureThumbnail(
	sandbox: SandboxInstance,
	notebooks: NotebookService,
	pid: ProjectId,
	nid: NotebookId,
	sandboxId: string,
	workdir = '/workspace',
	deadlineAt = Date.now() + 10_000,
): Promise<void> {
	const started = Date.now();
	const deadline = Math.min(deadlineAt, started + 10_000);
	const workDeadline = deadline - 500;
	let outcome = 'skipped';
	let timer: ReturnType<typeof setTimeout> | undefined;
	let cancelled = false;
	let execution: ReturnType<SandboxInstance['exec']> | undefined;
	const remaining = () => Math.max(0, workDeadline - Date.now());
	const expired = () => cancelled || remaining() === 0;
	const run = async () => {
		if (remaining() < 1000) {
			outcome = 'insufficient_budget';
			return;
		}
		const capture = await notebooks.thumbnails.prepare(pid, nid, (reason) => {
			if (!expired()) outcome = reason;
		});
		if (!capture || expired()) return;
		if (remaining() < 1000) {
			outcome = 'insufficient_budget';
			return;
		}
		const claimed = await notebooks.thumbnails.claimAttempt(pid, nid, sandboxId);
		if (expired()) return;
		if (!claimed) {
			outcome = 'already_attempted';
			return;
		}
		const input = `/tmp/marimohub-thumbnail-${crypto.randomUUID()}.html`;
		await sandbox.writeFiles([{ path: input, content: capture.html }]);
		if (expired()) return;
		if (remaining() < 1000) {
			outcome = 'insufficient_budget';
			return;
		}
		const venv = shellQuote(`${workdir}/.venv/bin/python`);
		const args = `-c ${shellQuote(THUMBNAIL_PROGRAM)} ${shellQuote(input)} ${workDeadline / 1000}`;
		const command = `if [ -x ${venv} ]; then exec ${venv} ${args}; else exec python3 ${args}; fi`;
		execution = sandbox.exec(command, { timeout: remaining() });
		const result = await execution;
		if (expired()) return;
		if (!result.success) {
			outcome = 'exec_failed';
			return;
		}
		const response = CaptureResponseSchema.parse(JSON.parse(result.stdout.trim()));
		outcome = response.status;
		if (response.status !== 'ok' || !response.png || expired()) return;
		const bytes = Uint8Array.from(atob(response.png), (c) => c.charCodeAt(0));
		const published = await notebooks.thumbnails.publish(pid, nid, capture, bytes, workDeadline);
		if (!expired()) outcome = published ? 'captured' : 'superseded';
	};
	try {
		await Promise.race([
			run(),
			new Promise<void>((resolve) => {
				timer = setTimeout(() => {
					cancelled = true;
					outcome = 'timeout';
					resolve();
				}, remaining());
			}),
		]);
	} catch {
		if (!cancelled) outcome = 'failed';
	} finally {
		cancelled = true;
		if (timer) clearTimeout(timer);
		// The helper and exec have their own deadlines. Allow transport cleanup to settle,
		// without letting an unresponsive provider hold up sandbox destruction.
		if (execution) {
			await Promise.race([
				execution.catch(() => {}),
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
				}),
			]);
		}
		if (timer) clearTimeout(timer);
		logEvent({
			event: 'thumbnail_capture',
			notebook_id: nid,
			outcome,
			duration_ms: Date.now() - started,
		});
	}
}
