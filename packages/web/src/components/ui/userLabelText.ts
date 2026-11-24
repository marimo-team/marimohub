import type { ResolvedUser } from '@/types';

export function displayName(user: ResolvedUser | undefined, fallbackId: string): string {
	if (fallbackId.startsWith('system:public-app:')) return 'Public visitor';
	return user?.name || user?.email || fallbackId;
}
