import { useQuery, useSuspenseQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import { userKeys, projectKeys, notebookKeys } from './queryKeys';
import type { User, ProjectSummary, NotebookEntry, NotebookMeta, Session } from '../types';

// Auth
export function useUserQuery() {
	return useQuery({
		queryKey: userKeys.me(),
		queryFn: () => apiFetch<User>('/api/me'),
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
}

// Projects
export function useProjectsQuery() {
	return useSuspenseQuery({
		queryKey: projectKeys.list(),
		queryFn: () => apiFetch<ProjectSummary[]>('/api/projects'),
	});
}

export function useCreateProject() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (body: { name: string; description: string }) =>
			apiFetch<ProjectSummary>('/api/projects', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: projectKeys.list() });
		},
	});
}

export function useDeleteProject() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (projectId: string) =>
			apiFetch<void>(`/api/projects/${projectId}`, { method: 'DELETE' }),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: projectKeys.list() });
		},
	});
}

// Notebooks
export function useNotebooksQuery(projectId: string) {
	return useSuspenseQuery({
		queryKey: notebookKeys.list(projectId),
		queryFn: () => apiFetch<NotebookEntry[]>(`/api/projects/${projectId}/notebooks`),
	});
}

export function useCreateNotebook(projectId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (body: { title: string; description: string; code: string }) =>
			apiFetch<NotebookMeta>(`/api/projects/${projectId}/notebooks`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: notebookKeys.list(projectId) });
		},
	});
}

export function useDeleteNotebook(projectId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (notebookId: string) =>
			apiFetch<void>(`/api/projects/${projectId}/notebooks/${notebookId}`, {
				method: 'DELETE',
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: notebookKeys.list(projectId) });
		},
	});
}

// Sessions
export function useStartSession(projectId: string, notebookId: string) {
	return useMutation({
		mutationFn: () =>
			apiFetch<Session>(`/api/projects/${projectId}/notebooks/${notebookId}/sessions`, {
				method: 'POST',
			}),
	});
}

export function useStopSession(projectId: string, notebookId: string) {
	return useMutation({
		mutationFn: (sessionId: string) =>
			apiFetch<void>(`/api/projects/${projectId}/notebooks/${notebookId}/sessions/${sessionId}`, {
				method: 'DELETE',
			}),
	});
}
