import type { SecondarySurfaceId } from '@/types';

export const SURFACE_LABELS = {
	vscode: 'VS Code',
	opencode: 'OpenCode',
} as const satisfies Record<SecondarySurfaceId, string>;
