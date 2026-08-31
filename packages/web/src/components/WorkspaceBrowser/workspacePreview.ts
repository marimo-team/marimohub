import type { FileItem } from '@marimo-team/react-finder';

export const MAX_TEXT_EDITOR_BYTES = 1024 * 1024;

const TEXT_MIME_TYPE = /^(text\/|application\/(json|toml|yaml))/;
const TEXT_FILE_EXTENSION = /\.(py|md|txt|csv|tsv|json|toml|ya?ml|js|ts|tsx|jsx|css|html)$/i;

export function isWorkspaceTextFile(item: Pick<FileItem, 'mimeType' | 'name'>): boolean {
	return TEXT_MIME_TYPE.test(item.mimeType ?? '') || TEXT_FILE_EXTENSION.test(item.name);
}

export function decodeWorkspaceText(buffer: ArrayBuffer): string | null {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
	} catch {
		return null;
	}
}
