import { z } from 'zod';
import { BoundedLruMap } from '../../cache';
import { MAX_ARTIFACT_BYTES } from '../../constants';
import { sha256Hex } from '../../internal/sha256';
import type { CommitSessionInput } from '../content/NotebookService';
import type { SandboxInstance } from '../../ports/sandbox';
import { shellQuote } from './shell';
import { sessionArtifactPaths } from './sandboxFiles';

export type ArtifactFingerprints = z.infer<typeof FingerprintsSchema>;
export interface CachedSessionArtifacts {
	fingerprints: ArtifactFingerprints;
	artifacts: CommitSessionInput;
}

const FIELDS = ['code', 'deps', 'html', 'session'] as const;
const FingerprintsSchema = z.record(
	z.enum(FIELDS),
	z
		.object({
			size: z.number().int().min(0).max(MAX_ARTIFACT_BYTES),
			sha256: z.string().regex(/^[a-f0-9]{64}$/),
		})
		.nullable(),
);
const PROBE = `import hashlib,json,os,stat,sys
result={}
for name,path in json.loads(sys.argv[1]).items():
 try:
  fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 except FileNotFoundError:
  result[name]=None
  continue
 with os.fdopen(fd,'rb') as f:
  before=os.fstat(f.fileno())
  if not stat.S_ISREG(before.st_mode) or before.st_size>${MAX_ARTIFACT_BYTES}:
   raise ValueError('Unsupported artifact')
  digest=hashlib.sha256()
  total=0
  while True:
   chunk=f.read(min(65536,${MAX_ARTIFACT_BYTES}+1-total))
   if not chunk: break
   total+=len(chunk)
   if total>${MAX_ARTIFACT_BYTES}: raise ValueError('Artifact exceeds size limit')
   digest.update(chunk)
  after=os.fstat(f.fileno())
  if (before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_size,after.st_mtime_ns,after.st_ctime_ns):
   raise ValueError('Artifact changed during probe')
  result[name]={'size':total,'sha256':digest.hexdigest()}
print(json.dumps(result))`;

export async function probeSessionArtifacts(
	sandbox: SandboxInstance,
	mountPath: string,
	entryNotebook: string,
): Promise<ArtifactFingerprints | undefined> {
	if (!sandbox.readFileBounded) return;
	const paths = sessionArtifactPaths(mountPath, entryNotebook);
	const processPaths = Object.fromEntries(
		FIELDS.map((field) => [field, sandbox.resolveProcessPath?.(paths[field]) ?? paths[field]]),
	);
	try {
		const result = await sandbox.exec(
			`python3 -I -c ${shellQuote(PROBE)} ${shellQuote(JSON.stringify(processPaths))}`,
			{ timeout: 10_000, maxOutputBytes: 4096 },
		);
		if (!result.success || result.stdout.length > 4096) return;
		return FingerprintsSchema.safeParse(JSON.parse(result.stdout)).data;
	} catch {
		// A failed optimization must fall back to the bounded read's error handling.
		return;
	}
}

export function reusableSessionArtifacts(
	fingerprints: ArtifactFingerprints,
	previous?: CachedSessionArtifacts,
): CommitSessionInput {
	const reusable: CommitSessionInput = {};
	for (const field of FIELDS) {
		const next = fingerprints[field];
		const old = previous?.fingerprints[field];
		if (field !== 'code' && next === null) reusable[field] = undefined;
		else if (next && old && next.size === old.size && next.sha256 === old.sha256)
			reusable[field] = previous.artifacts[field];
	}
	return reusable;
}

export function sameArtifactFingerprints(
	a: ArtifactFingerprints,
	b: ArtifactFingerprints,
): boolean {
	return FIELDS.every(
		(field) => a[field]?.size === b[field]?.size && a[field]?.sha256 === b[field]?.sha256,
	);
}

function artifactBytes(value: CachedSessionArtifacts): number {
	return Object.values(value.artifacts).reduce(
		(sum, content) => sum + (content?.length ?? 0) * 2,
		1024,
	);
}

export class SessionArtifactCache {
	private readonly entries: BoundedLruMap<string, CachedSessionArtifacts>;
	constructor(
		maxEntries = 128,
		private readonly maxBytes = 64 * 1024 * 1024,
	) {
		this.entries = new BoundedLruMap(maxEntries, { weigh: artifactBytes, maxWeight: maxBytes });
	}

	get(key: string): CachedSessionArtifacts | undefined {
		const value = this.entries.get(key);
		return value && structuredClone(value);
	}

	async remember(key: string, value: CachedSessionArtifacts): Promise<void> {
		for (const field of FIELDS) {
			const fingerprint = value.fingerprints[field];
			const content = value.artifacts[field];
			if (
				fingerprint === null
					? content !== undefined
					: content === undefined ||
						new TextEncoder().encode(content).byteLength !== fingerprint.size ||
						(await sha256Hex(content)) !== fingerprint.sha256
			)
				return;
		}
		if (artifactBytes(value) > this.maxBytes) return;
		this.entries.set(key, structuredClone(value));
	}
}
