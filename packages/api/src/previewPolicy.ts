import { DEFAULT_APP_POOL_POLICY, PREVIEW_IDLE_MS } from '@marimo-hub/core';
import type { AppPoolPolicy } from '@marimo-hub/core';

export const PREVIEW_MAX_SESSIONS = 10;
const PREVIEW_MAX_APP_REPLICAS = 2;

export function previewIdleTimeout(configured?: number): number {
	return Math.min(configured ?? PREVIEW_IDLE_MS, PREVIEW_IDLE_MS);
}

export function previewAppPoolPolicy(configured?: AppPoolPolicy): AppPoolPolicy {
	return {
		...DEFAULT_APP_POOL_POLICY,
		...configured,
		idleMs: previewIdleTimeout(configured?.idleMs),
		maxSessionsPerVersion: Math.min(
			configured?.maxSessionsPerVersion ?? PREVIEW_MAX_APP_REPLICAS,
			PREVIEW_MAX_APP_REPLICAS,
		),
	};
}
