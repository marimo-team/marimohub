import { shellQuote } from './shell';
interface SandboxFileWrite {
	path: string;
	content: string | Uint8Array;
}

export const MAX_WRITE_BATCH_FILES = 128;
export const MAX_WRITE_BATCH_BYTES = 4 * 1024 * 1024;
export const WRITE_BATCH_CONCURRENCY = 2;
const END_OF_BATCH = 'null\n';
const encoder = new TextEncoder();

function contentBytes(content: SandboxFileWrite['content']): number {
	if (typeof content !== 'string') return content.byteLength;
	let bytes = 0;
	for (let index = 0; index < content.length; index++) {
		const point = content.codePointAt(index)!;
		bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
		if (point > 0xffff) index++;
	}
	return bytes;
}

function frameHeader(file: SandboxFileWrite, size: number): string {
	return `${JSON.stringify({ path: file.path, size })}\n`;
}

export function batchFileWrites(files: readonly SandboxFileWrite[]): SandboxFileWrite[][] {
	const batches: SandboxFileWrite[][] = [];
	let batch: SandboxFileWrite[] = [];
	let bytes = END_OF_BATCH.length;
	for (const file of files) {
		const size = contentBytes(file.content);
		const weight = encoder.encode(frameHeader(file, size)).byteLength + size;
		if (
			batch.length > 0 &&
			(batch.length >= MAX_WRITE_BATCH_FILES || bytes + weight > MAX_WRITE_BATCH_BYTES)
		) {
			batches.push(batch);
			batch = [];
			bytes = END_OF_BATCH.length;
		}
		batch.push(file);
		bytes += weight;
	}
	if (batch.length > 0) batches.push(batch);
	return batches;
}

export function encodeFileWriteBatch(files: readonly SandboxFileWrite[]): Uint8Array {
	const chunks: Uint8Array[] = [];
	for (const file of files) {
		const content = typeof file.content === 'string' ? encoder.encode(file.content) : file.content;
		chunks.push(encoder.encode(frameHeader(file, content.byteLength)), content);
	}
	chunks.push(encoder.encode(END_OF_BATCH));
	const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

// Length frames keep binary contents and paths out of shell syntax. The terminal
// marker distinguishes a complete batch from a connection lost between files.
// `-I` keeps a workspace `json.py` in the cwd (or PYTHONPATH) from shadowing the stdlib.
export const WRITE_BATCH_COMMAND = `python3 -I -c ${shellQuote(String.raw`import json, os, sys
stream = sys.stdin.buffer
while True:
    header = stream.readline()
    if not header.endswith(b"\n"):
        raise RuntimeError("Incomplete file batch header")
    entry = json.loads(header)
    if entry is None:
        if stream.read(1):
            raise RuntimeError("Unexpected data after file batch")
        break
    path, remaining = entry["path"], entry["size"]
    if type(remaining) is not int or remaining < 0:
        raise ValueError("Invalid file length")
    # Parent symlinks include adapter-managed user-home mounts; this transport has no workspace root.
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "wb") as target:
        # Retain owner execute permission for scripts, but remove shared access before writing.
        os.fchmod(target.fileno(), os.fstat(target.fileno()).st_mode & 0o700)
        while remaining:
            chunk = stream.read(min(remaining, 65536))
            if not chunk:
                raise RuntimeError("Incomplete file contents: " + path)
            target.write(chunk)
            remaining -= len(chunk)
`)}`;
