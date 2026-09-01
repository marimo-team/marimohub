import type { ResolvedUser } from '@/types';

export function displayName(user: ResolvedUser | undefined, fallbackId: string): string {
	return user?.name || user?.email || fallbackId;
}
