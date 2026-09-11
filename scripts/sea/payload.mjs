// What goes inside the SEA, and the id that identifies it.
//
// The id names the cache directory the launcher unpacks into, and a directory
// carrying its `.ready` marker is reused as-is forever after. So everything
// that decides what lands on disk, or that reads it back, has to feed the hash:
// asset paths, asset contents, the import shim, and launcher.cjs itself.
// Miss one and an upgraded binary silently runs an older payload.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const walk = (dir) =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name);
		return entry.isDirectory() ? walk(full) : [full];
	});

// The name the launcher requires out of the unpacked payload directory.
export const SHIM_ASSET = 'importShim.cjs';

// Returns the SEA asset map (key -> source path) and the payload's build id.
// Keys are POSIX-style relative paths; the launcher unpacks them by the names
// listed in manifest.json.
export function collectPayload({ serverDist, webDist, shim, launcher }) {
	const assets = {};
	const hash = createHash('sha256');
	// Length-prefixed, so where one field ends and the next begins is never in
	// doubt. Concatenating them raw lets different payloads hash alike without
	// any SHA weakness: {a: 'A', b: 'B'} and {a: 'Adist/bB'} both produce
	// `dist/aAdist/bB`, and the second would then run out of the first's cache.
	const addField = (value) => {
		const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
		hash.update(`${bytes.length}:`).update(bytes);
	};
	const addFile = (key, file) => {
		assets[key] = file;
		addField(key);
		addField(readFileSync(file));
	};
	const addTree = (root, prefix) => {
		for (const file of walk(root).sort()) {
			addFile(`${prefix}/${relative(root, file).split('\\').join('/')}`, file);
		}
	};
	addTree(serverDist, 'dist');
	addTree(webDist, 'public');
	addFile(SHIM_ASSET, shim);
	// The launcher is the SEA main rather than an asset, so it has no key of its
	// own; the literal keeps its bytes from colliding with a keyed entry.
	addField('launcher');
	addField(readFileSync(launcher));
	return { assets, buildId: hash.digest('hex').slice(0, 16) };
}
