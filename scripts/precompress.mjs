import { readFileSync, writeFileSync } from 'node:fs';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const MIN_BYTES = 1024;

/** Writes `.br` and `.gz` siblings next to `path`, keeping each only when it is smaller. */
export function precompressFile(path, { extensions }) {
	if (!extensions.some((extension) => path.endsWith(`.${extension}`))) return;
	const bytes = readFileSync(path);
	if (bytes.byteLength < MIN_BYTES) return;
	const variants = {
		br: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }),
		gz: gzipSync(bytes, { level: 9 }),
	};
	for (const [suffix, compressed] of Object.entries(variants)) {
		if (compressed.byteLength < bytes.byteLength) writeFileSync(`${path}.${suffix}`, compressed);
	}
}
