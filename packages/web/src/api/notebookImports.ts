import { apiClient, apiData } from './client';

export const notebookImports = {
	prepare: (projectId: string, bytes: Uint8Array<ArrayBuffer>, signal?: AbortSignal) =>
		apiData(
			apiClient.POST('/api/v1/projects/{pid}/notebook-imports', {
				params: { path: { pid: projectId } },
				// The schema types the application/zip body as a string; send the raw bytes instead.
				body: '',
				bodySerializer: () => bytes,
				headers: { 'Content-Type': 'application/zip' },
				timeout: 300_000,
				signal,
			}),
		),
	publish: (
		projectId: string,
		importId: string,
		body: { entry_notebook: string; title: string; base_image?: string; compute_profile?: string },
	) =>
		apiData(
			apiClient.POST('/api/v1/projects/{pid}/notebook-imports/{import_id}/notebooks', {
				params: { path: { pid: projectId, import_id: importId } },
				body,
				timeout: 120_000,
			}),
		),
	get: (projectId: string, importId: string) =>
		apiData(
			apiClient.GET('/api/v1/projects/{pid}/notebook-imports/{import_id}', {
				params: { path: { pid: projectId, import_id: importId } },
			}),
		),
};
