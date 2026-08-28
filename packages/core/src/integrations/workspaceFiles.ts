import { normalizeWorkspaceFilePath } from './remoteWorkspace';

const WORKSPACE_MIME_TYPES: Readonly<Record<string, string>> = {
	'.avif': 'image/avif',
	'.csv': 'text/csv',
	'.gif': 'image/gif',
	'.html': 'text/html',
	'.jpeg': 'image/jpeg',
	'.jpg': 'image/jpeg',
	'.json': 'application/json',
	'.md': 'text/markdown',
	'.png': 'image/png',
	'.py': 'text/x-python',
	'.svg': 'image/svg+xml',
	'.toml': 'application/toml',
	'.tsv': 'text/tab-separated-values',
	'.txt': 'text/plain',
	'.webp': 'image/webp',
	'.yaml': 'application/yaml',
	'.yml': 'application/yaml',
};

export function normalizeWorkspacePathInput(path: string): string {
	if (path.startsWith('//')) {
		return normalizeWorkspaceFilePath(path);
	}
	return normalizeWorkspaceFilePath(path.replace(/^\//, ''));
}

export function normalizeWorkspaceDirectoryInput(path: string): string {
	if (path === '' || path === '/') return '';
	if (path.startsWith('//') || path.endsWith('//')) {
		return normalizeWorkspaceFilePath(path);
	}
	return normalizeWorkspaceFilePath(path.replaceAll(/^\/|\/$/g, ''));
}

export function workspacePathName(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}

export function workspaceMimeType(path: string): string {
	const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
	return WORKSPACE_MIME_TYPES[extension] ?? 'application/octet-stream';
}
