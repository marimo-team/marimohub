import type { TokenGrant } from '@/types';

export interface TokenGrantDraft {
	actions: TokenGrant['actions'] | null;
	projects: TokenGrant['projects'] | null;
}

export function tokenGrantFromDraft(value: TokenGrantDraft): TokenGrant | null {
	if (value.actions === null || value.projects === null) return null;
	if (Array.isArray(value.projects) && value.projects.length === 0) return null;
	return { actions: value.actions, projects: value.projects };
}
