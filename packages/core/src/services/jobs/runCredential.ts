import { z } from 'zod';
import { ProjectId, NotebookId, JobId, RunId } from '../../ids';
import type { JobRun } from '../../schema';
import { fromBase64Url, toBase64Url } from '../../internal/base64url';

export const RUN_CREDENTIAL_PREFIX = 'mhub_run_';
const claimsSchema = z.strictObject({
	project_id: z.string().transform(ProjectId.parse),
	notebook_id: z.string().transform(NotebookId.parse),
	job_id: z.string().transform(JobId.parse),
	run_id: z.string().transform(RunId.parse),
	attempt: z.number().int().positive(),
	nonce: z.string(),
});

export function createRunCredential(run: JobRun): string {
	const claims = {
		project_id: run.project_id,
		notebook_id: run.notebook_id,
		job_id: run.job_id,
		run_id: run.run_id,
		attempt: run.attempt,
		nonce: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
	};
	return RUN_CREDENTIAL_PREFIX + toBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
}

export function parseRunCredential(token: string) {
	if (!token.startsWith(RUN_CREDENTIAL_PREFIX) || token.length > 2048) return null;
	try {
		return claimsSchema.parse(
			JSON.parse(
				new TextDecoder().decode(fromBase64Url(token.slice(RUN_CREDENTIAL_PREFIX.length))),
			),
		);
	} catch {
		return null;
	}
}

export async function hashRunCredential(token: string): Promise<string> {
	return toBase64Url(
		new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))),
	);
}
