import type { SessionMode } from '../../constants';
import type { SessionId } from '../../ids';
import type { Session } from '../../schema';
import { ConflictError, ResourceExhaustedError } from '../../errors';

export function admissionCaps(
	mode: SessionMode,
	policy: { maxConcurrentSessionsPerUser?: number; maxAppsPerProject?: number },
) {
	if (mode === 'app')
		return [
			{
				scope: 'project' as const,
				max: policy.maxAppsPerProject,
				preflight: true,
				message: (max: number) =>
					`Concurrent app limit reached for this project (${max}). Stop an app before starting another.`,
			},
			{
				scope: 'user-apps' as const,
				max: policy.maxConcurrentSessionsPerUser,
				preflight: false,
				message: (max: number) =>
					`Concurrent app limit reached (${max} apps started by you). Stop an app before starting another.`,
			},
		];
	return [
		{
			scope: 'user-editors' as const,
			max: policy.maxConcurrentSessionsPerUser,
			preflight: false,
			message: (max: number) =>
				`Concurrent session limit reached (${max}). Terminate a session before starting another.`,
		},
	];
}

export function assertAdmissionRank(
	sessions: readonly Session[],
	sessionId: SessionId,
	max: number,
	message: string,
): void {
	const rank = sessions.findIndex((session) => session.session_id === sessionId);
	if (rank === -1) throw new ConflictError('Session admission changed. Retry shortly.');
	if (rank >= max) throw new ResourceExhaustedError(message);
}
