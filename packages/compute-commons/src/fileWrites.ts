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
	return typeof content === 'string' ? encoder.encode(content).byteLength : content.byteLength;
}

function frameHeader(file: SandboxFileWrite): string {
	return `${JSON.stringify({ path: file.path, size: contentBytes(file.content) })}\n`;
}

export function batchFileWrites(files: readonly SandboxFileWrite[]): SandboxFileWrite[][] {
	const batches: SandboxFileWrite[][] = [];
	let batch: SandboxFileWrite[] = [];
	let bytes = END_OF_BATCH.length;
	for (const file of files) {
		const weight = encoder.encode(frameHeader(file)).byteLength + contentBytes(file.content);
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
		chunks.push(encoder.encode(frameHeader(file)));
		chunks.push(typeof file.content === 'string' ? encoder.encode(file.content) : file.content);
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
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "wb") as target:
        while remaining:
            chunk = stream.read(min(remaining, 65536))
            if not chunk:
                raise RuntimeError("Incomplete file contents: " + path)
            target.write(chunk)
            remaining -= len(chunk)
`)}`;
