import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { isSafeWorkspacePath } from './remoteWorkspace';

const PACKED_WORKSPACE_COMPRESSION_LEVEL = 1;
export const MAX_PACKED_WORKSPACE_INPUT_BYTES = 32 * 1024 * 1024;

export interface PackedWorkspaceInput {
	workspace: ReadonlyMap<string, Uint8Array>;
	git?: ReadonlyMap<string, Uint8Array>;
}

function addEntry(entries: Map<string, Uint8Array>, path: string, bytes: Uint8Array): void {
	if (!isSafeWorkspacePath(path)) throw new Error(`Unsafe packed workspace path: ${path}`);
	if (entries.has(path)) throw new Error(`Duplicate packed workspace path: ${path}`);
	entries.set(path, bytes);
}

function encodeZip(entries: ReadonlyMap<string, Uint8Array>): Uint8Array {
	const chunks: Uint8Array[] = [];
	const archive = new Zip((error, chunk) => {
		if (error) throw error;
		chunks.push(new Uint8Array(chunk));
	});
	for (const [path, bytes] of entries) {
		const file = path.startsWith('.git/objects/')
			? new ZipPassThrough(path)
			: new ZipDeflate(path, { level: PACKED_WORKSPACE_COMPRESSION_LEVEL });
		archive.add(file);
		file.push(bytes, true);
	}
	archive.end();

	const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
	const result = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

export function packedWorkspaceInputBytes(input: PackedWorkspaceInput): number {
	let total = 0;
	for (const [path, bytes] of input.workspace) {
		if (input.git && (path === '.git' || path.startsWith('.git/'))) continue;
		total += bytes.byteLength;
	}
	for (const bytes of input.git?.values() ?? []) total += bytes.byteLength;
	return total;
}

export function isPackedWorkspaceInputWithinLimit(
	input: PackedWorkspaceInput,
	limit = MAX_PACKED_WORKSPACE_INPUT_BYTES,
): boolean {
	return packedWorkspaceInputBytes(input) <= limit;
}

export function createPackedWorkspaceArchive(input: PackedWorkspaceInput): Uint8Array {
	const entries = new Map<string, Uint8Array>();
	for (const [path, bytes] of input.workspace) {
		if (input.git && (path === '.git' || path.startsWith('.git/'))) continue;
		addEntry(entries, path, bytes);
	}
	for (const [path, bytes] of input.git ?? []) addEntry(entries, `.git/${path}`, bytes);
	return encodeZip(entries);
}
