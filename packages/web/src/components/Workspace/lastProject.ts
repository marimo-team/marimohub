import { appBasePath } from '@/lib/basePath';

export function lastProjectKey(userId: string) {
	return `marimohub:last-project:${appBasePath()}:${userId}`;
}

export function readLastProject(userId: string): string | null {
	try {
		return localStorage.getItem(lastProjectKey(userId));
	} catch {
		return null;
	}
}

export function rememberProject(userId: string, projectId: string) {
	try {
		localStorage.setItem(lastProjectKey(userId), projectId);
	} catch {}
}

export function forgetProject(userId: string, projectId: string) {
	try {
		if (readLastProject(userId) === projectId) localStorage.removeItem(lastProjectKey(userId));
	} catch {}
}
