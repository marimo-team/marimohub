import { apiClient, apiData } from './client';

export const notebookImports = {
	prepare: (projectId: string, bytes: Uint8Array<ArrayBuffer>) =>
		apiData(
			apiClient.POST('/api/v1/projects/{pid}/notebook-imports', {
				params: { path: { pid: projectId } },
				body: '',
				bodySerializer: () => new Blob([bytes], { type: 'application/zip' }),
				headers: { 'Content-Type': 'application/zip' },
				timeout: 120_000,
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
	status: (projectId: string, importId: string, entry: string) =>
		apiData(
			apiClient.GET('/api/v1/projects/{pid}/notebook-imports/{import_id}/notebooks', {
				params: { path: { pid: projectId, import_id: importId }, query: { entry_notebook: entry } },
			}),
		),
};
