import { z } from 'zod';
import { WorkspaceManifestSchema } from './workspaceManifest';
import { MAX_REQUEST_BYTES, MAX_WORKSPACE_FILE_BYTES } from '../../constants';
import { ConflictError, NotFoundError, ValidationError } from '../../errors';
import { isSafeWorkspacePath } from '../../integrations/remoteWorkspace';
import {
	isRegenerableArtifactPath,
	REGENERABLE_DIRECTORY_NAMES,
	REGENERABLE_FILE_NAMES,
} from '../../integrations/workspaceIgnore';
import type { Bucket } from '../../ports/bucket';
import type { SandboxInstance } from '../../ports/sandbox';
import type { NotebookProposal, ProposalChange } from '../../schema';
import type { VersionPaths } from '../../paths';
import { shellQuote } from '../runtime/shell';
import type { SandboxWorkspaceLayout } from '../runtime/workspaceLayout';
import {
	decodeProposalContent,
	proposalBytesEqual,
	proposalSha256,
	proposalRepositoryPath,
} from './proposalUtils';
import { listAllObjects } from '../catalog/storage';

export const MAX_PROPOSAL_CHANGES = 1_000;

export interface CapturedProposalChange {
	change: ProposalChange;
	content?: Uint8Array;
}

export interface CapturedProposalChanges {
	strategy: NotebookProposal['capture_strategy'];
	changes: CapturedProposalChange[];
}

// Repository metadata and marimo runtime state are never proposal content.
const PROPOSAL_IGNORED_DIRECTORY_NAMES = new Set([
	...REGENERABLE_DIRECTORY_NAMES,
	'.git',
	'__marimo__',
]);

const GIT_EXCLUDE_PATHS = [
	...[...PROPOSAL_IGNORED_DIRECTORY_NAMES].map((name) => `:(exclude,glob)**/${name}/**`),
	...[...REGENERABLE_FILE_NAMES].map((name) => `:(exclude,glob)**/${name}`),
];

const OPEN_REGULAR_FILE_SCRIPT = `
import os
import stat

def open_regular(root, relative_path):
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    directory_fd = os.open(root, directory_flags)
    try:
        for component in relative_path.split('/')[:-1]:
            next_fd = os.open(component, directory_flags, dir_fd=directory_fd)
            os.close(directory_fd)
            directory_fd = next_fd
        file_fd = os.open(
            relative_path.split('/')[-1],
            os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW,
            dir_fd=directory_fd,
        )
        if not stat.S_ISREG(os.fstat(file_fd).st_mode):
            os.close(file_fd)
            raise OSError('not a regular file')
        return file_fd
    finally:
        os.close(directory_fd)
`.trim();

const READ_REGULAR_FILE_SCRIPT = `
${OPEN_REGULAR_FILE_SCRIPT}
import base64
import sys

root, relative_path, limit_text = sys.argv[1:4]
allow_missing = len(sys.argv) > 4 and sys.argv[4] == "allow-missing"
try:
    with os.fdopen(open_regular(root, relative_path), 'rb') as file:
        content = file.read(int(limit_text) + 1)
    sys.stdout.buffer.write(base64.b64encode(content))
except FileNotFoundError:
    if not allow_missing:
        raise
    sys.stdout.write("-")
`.trim();

const HASH_REGULAR_FILES_SCRIPT = `
${OPEN_REGULAR_FILE_SCRIPT}
import hashlib
import json
import sys

class FileTooLarge(Exception):
    pass

root, paths_json, limit_text = sys.argv[1:4]
result = []
for path in json.loads(paths_json):
    try:
        with os.fdopen(open_regular(root, path), 'rb') as file:
            digest = hashlib.sha256()
            size = 0
            while True:
                chunk = file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > int(limit_text):
                    raise FileTooLarge()
                digest.update(chunk)
        result.append(dict(path=path, size_bytes=size, sha256=digest.hexdigest()))
    except FileTooLarge:
        result.append(dict(path=path, error='too_large'))
    except FileNotFoundError:
        result.append(dict(path=path, missing=True))
print(json.dumps(result))
`.trim();

const WorkingTreeDigestSchema = z.union([
	WorkspaceManifestSchema.element,
	z.object({ path: z.string(), missing: z.literal(true) }),
	z.object({ path: z.string(), error: z.literal('too_large') }),
]);

function pythonCommand(args: string): string {
	return `if command -v python3 >/dev/null 2>&1; then marimohub_python=python3; elif command -v python >/dev/null 2>&1; then marimohub_python=python; else exit 127; fi; "$marimohub_python" -c ${args}`;
}

async function workingTreeDigests(
	sandbox: SandboxInstance,
	tree: SandboxWorkspaceLayout,
	candidates: string[],
	renew: () => Promise<void>,
) {
	const result = new Map<
		string,
		Exclude<z.infer<typeof WorkingTreeDigestSchema>, { error: string }>
	>();
	// Bound argv size and each hash pass so large folders can renew their lease between batches.
	for (let offset = 0; offset < candidates.length; ) {
		const batch: string[] = [];
		let argumentBytes = 0;
		while (offset < candidates.length && batch.length < 256) {
			const path = proposalRepositoryPath(tree.rootPath, candidates[offset]);
			const bytes = new TextEncoder().encode(shellQuote(JSON.stringify(path))).byteLength;
			if (batch.length > 0 && argumentBytes + bytes > 32_000) break;
			batch.push(path);
			argumentBytes += bytes;
			offset++;
		}
		await renew();
		const hashed = await sandbox.exec(
			pythonCommand(
				`${shellQuote(HASH_REGULAR_FILES_SCRIPT)} ${shellQuote(tree.gitRoot)} ${shellQuote(JSON.stringify(batch))} ${MAX_WORKSPACE_FILE_BYTES}`,
			),
			{ timeout: 60_000 },
		);
		await renew();
		if (!hashed.success) throw gitConflict('Could not securely read working tree files', hashed);
		const entries = z.array(WorkingTreeDigestSchema).parse(JSON.parse(hashed.stdout));
		if (entries.length !== batch.length || entries.some((entry, i) => entry.path !== batch[i]))
			throw new ConflictError('Working tree digest paths do not match the request');
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			if ('error' in entry)
				throw new ValidationError(
					`Changed file ${entry.path} exceeds the ${MAX_WORKSPACE_FILE_BYTES}-byte limit`,
				);
			result.set(candidates[offset - batch.length + i], entry);
		}
	}
	return result;
}

function isIgnoredPath(path: string): boolean {
	return (
		isRegenerableArtifactPath(path) ||
		path.split('/').some((segment) => PROPOSAL_IGNORED_DIRECTORY_NAMES.has(segment))
	);
}

function assertGitChangePath(path: string): void {
	let hasControlCharacter = false;
	for (let index = 0; index < path.length; index++) {
		const code = path.charCodeAt(index);
		if (code < 0x20 || code === 0x7f) {
			hasControlCharacter = true;
			break;
		}
	}
	if (!isSafeWorkspacePath(path) || hasControlCharacter) {
		throw new ValidationError(`Invalid Git change path: ${path}`);
	}
}

function workingDirectory(value: string): string {
	return value.replace(/\/+$/, '') || '/';
}

function sandboxPath(workdir: string, relativePath: string): string {
	return workdir === '/' ? `/${relativePath}` : `${workdir}/${relativePath}`;
}

function parseNullTerminated(stdout: string, description: string): string[] {
	if (!stdout) return [];
	if (!stdout.endsWith('\0')) {
		throw new ConflictError(`Git returned malformed ${description}`);
	}
	return stdout.slice(0, -1).split('\0');
}

function parseGitDiff(stdout: string): Map<string, 'add' | 'modify' | 'delete'> {
	const fields = parseNullTerminated(stdout, 'diff output');
	if (fields.length % 2 !== 0) throw new ConflictError('Git returned malformed diff output');
	const operations = new Map<string, 'add' | 'modify' | 'delete'>();
	for (let index = 0; index < fields.length; index += 2) {
		const status = fields[index];
		const path = fields[index + 1];
		if (!path) throw new ValidationError('Invalid Git change path: ');
		assertGitChangePath(path);
		if (isIgnoredPath(path)) continue;
		const operation =
			status === 'A' ? 'add' : status === 'M' ? 'modify' : status === 'D' ? 'delete' : null;
		if (!operation) {
			throw new ConflictError(`Git change type ${status || '(empty)'} is not supported`);
		}
		operations.set(path, operation);
	}
	return operations;
}

function gitPathspec(): string {
	return ['.', ...GIT_EXCLUDE_PATHS].map(shellQuote).join(' ');
}

/** Git runs from the workdir so paths come back workdir-relative; only the Git root is trusted. */
type GitWorkingTree = Pick<SandboxWorkspaceLayout, 'workdir' | 'gitRoot'>;

function gitInWorkdir(tree: GitWorkingTree, args: string): string {
	// Modal restores `.git` as a different uid than the kernel user. Git 2.35+
	// then refuses the worktree unless this directory is trusted; `-c` keeps
	// capture working on sessions provisioned before gitconfig was updated.
	return `cd ${shellQuote(tree.workdir)} && git -c ${shellQuote(`safe.directory=${tree.gitRoot}`)} ${args}`;
}

function gitConflict(message: string, result: { stdout: string; stderr: string }): ConflictError {
	const detail = (result.stderr.trim() || result.stdout.trim())
		.replaceAll(/\s+/g, ' ')
		.slice(0, 1000);
	return new ConflictError(detail ? `${message}: ${detail}` : message);
}

async function hasGitWorkingTree(sandbox: SandboxInstance, gitRoot: string): Promise<boolean> {
	const result = await sandbox.exec(
		`cd ${shellQuote(gitRoot)} && test -e .git && command -v git >/dev/null 2>&1 && printf git-working-tree`,
	);
	return result.success && result.stdout === 'git-working-tree';
}

async function resolvedGitBase(
	sandbox: SandboxInstance,
	tree: GitWorkingTree,
	commit: string,
): Promise<string> {
	const result = await sandbox.exec(
		gitInWorkdir(tree, `rev-parse --verify ${shellQuote(`${commit}^{commit}`)}`),
	);
	if (!result.success) {
		throw gitConflict('The Git working tree does not contain the pinned source commit', result);
	}
	const resolved = result.stdout.trim();
	if (!/^[0-9a-fA-F]{40,64}$/.test(resolved)) {
		throw new ConflictError('Git returned an invalid pinned source commit');
	}
	return resolved;
}

async function inspectRegularFile(
	sandbox: SandboxInstance,
	workdir: string,
	path: string,
): Promise<number> {
	const components = path.split('/');
	let parent = workdir;
	for (const component of components.slice(0, -1)) {
		const listing = await sandbox.listFiles(parent, { includeHidden: true });
		if (!listing.success) throw new ConflictError(`Could not inspect changed file ${path}`);
		const entry = listing.files.find((candidate) => candidate.name === component);
		if (!entry) throw new ConflictError(`Changed file ${path} is missing from the session`);
		if (entry.type !== 'directory') {
			throw new ConflictError(`Changed path ${path} has a non-directory parent`);
		}
		parent = sandboxPath(parent, component);
	}
	const name = components.at(-1) ?? '';
	const listing = await sandbox.listFiles(parent, { includeHidden: true });
	if (!listing.success) throw new ConflictError(`Could not inspect changed file ${path}`);
	const file = listing.files.find((candidate) => candidate.name === name);
	if (!file) throw new ConflictError(`Changed file ${path} is missing from the session`);
	if (file.type !== 'file') {
		throw new ConflictError(`Changed path ${path} is not a regular file`);
	}
	if (!Number.isSafeInteger(file.size) || file.size < 0) {
		throw new ConflictError(`Changed file ${path} has invalid file metadata`);
	}
	if (file.size > MAX_REQUEST_BYTES) {
		throw new ValidationError(`Changed file ${path} exceeds the ${MAX_REQUEST_BYTES}-byte limit`);
	}
	return file.size;
}

async function readChangedFile(
	sandbox: SandboxInstance,
	workdir: string,
	path: string,
): Promise<Uint8Array> {
	await inspectRegularFile(sandbox, workdir, path);
	const result = await sandbox.readFile(sandboxPath(workdir, path));
	if (!result.success) throw new ConflictError(`Could not read changed file ${path}`);
	const content = decodeProposalContent(result.content, result.encoding);
	if (content.byteLength > MAX_REQUEST_BYTES) {
		throw new ValidationError(`Changed file ${path} exceeds the ${MAX_REQUEST_BYTES}-byte limit`);
	}
	return content;
}

async function readGitChangedFile(
	sandbox: SandboxInstance,
	workdir: string,
	path: string,
): Promise<Uint8Array>;
async function readGitChangedFile(
	sandbox: SandboxInstance,
	workdir: string,
	path: string,
	allowMissing: true,
	maxBytes?: number,
): Promise<Uint8Array | null>;
async function readGitChangedFile(
	sandbox: SandboxInstance,
	workdir: string,
	path: string,
	allowMissing = false,
	maxBytes = MAX_REQUEST_BYTES,
): Promise<Uint8Array | null> {
	const args = `${shellQuote(READ_REGULAR_FILE_SCRIPT)} ${shellQuote(workdir)} ${shellQuote(path)} ${maxBytes}${allowMissing ? ' allow-missing' : ''}`;
	const result = await sandbox.exec(pythonCommand(args), { timeout: 60_000 });
	if (!result.success) throw new ConflictError(`Could not securely read changed file ${path}`);
	if (allowMissing && result.stdout === '-') return null;
	const content = decodeProposalContent(result.stdout, 'base64');
	if (content.byteLength > maxBytes) {
		throw new ValidationError(`Changed file ${path} exceeds the ${maxBytes}-byte limit`);
	}
	return content;
}

async function captureGitWorkingTree(
	bucket: Bucket,
	sandbox: SandboxInstance,
	tree: GitWorkingTree,
	base: VersionPaths,
	source: NotebookProposal['source'],
): Promise<CapturedProposalChanges | null> {
	if (!(await hasGitWorkingTree(sandbox, tree.gitRoot))) return null;
	const { workdir } = tree;
	const resolvedBase = await resolvedGitBase(sandbox, tree, source.commit);
	const pathspec = gitPathspec();
	// `--relative` keeps a subtree workspace's paths workdir-relative, matching
	// the synced version's layout; `ls-files` is cwd-relative by default.
	const [diff, untracked] = await Promise.all([
		sandbox.exec(
			gitInWorkdir(
				tree,
				`diff --name-status -z --no-renames --relative ${shellQuote(resolvedBase)} -- ${pathspec}`,
			),
		),
		sandbox.exec(gitInWorkdir(tree, `ls-files --others --exclude-standard -z -- ${pathspec}`)),
	]);
	if (!diff.success || !untracked.success) {
		throw gitConflict('Could not inspect the Git working tree', !diff.success ? diff : untracked);
	}
	const operations = parseGitDiff(diff.stdout);
	for (const path of parseNullTerminated(untracked.stdout, 'untracked-file output')) {
		assertGitChangePath(path);
		if (!isIgnoredPath(path)) {
			operations.set(path, operations.get(path) === 'delete' ? 'modify' : 'add');
		}
	}
	if (operations.size > MAX_PROPOSAL_CHANGES) {
		throw new ValidationError(`Proposal exceeds the ${MAX_PROPOSAL_CHANGES}-change limit`);
	}

	const changes: CapturedProposalChange[] = [];
	let totalBytes = 0;
	for (const [path, operation] of [...operations].sort(([left], [right]) =>
		left < right ? -1 : left > right ? 1 : 0,
	)) {
		const baseObject = operation === 'add' ? null : await bucket.get(base.workspaceFile(path));
		if (operation !== 'add' && !baseObject) {
			// Provider workspace ingest omits symlinks and special files, although
			// they remain tracked in the restored Git index as missing paths.
			if (operation === 'delete') continue;
			throw new ConflictError(`Changed file ${path} is missing from the synced source version`);
		}
		if (operation === 'delete') {
			changes.push({ change: { path, operation } });
			continue;
		}
		const content = await readGitChangedFile(sandbox, workdir, path);
		if (baseObject && proposalBytesEqual(content, await baseObject.bytes())) continue;
		totalBytes += content.byteLength;
		if (totalBytes > MAX_REQUEST_BYTES) {
			throw new ValidationError(`Proposal changes exceed the ${MAX_REQUEST_BYTES}-byte limit`);
		}
		changes.push({
			change: {
				path,
				operation,
				size_bytes: content.byteLength,
				sha256: await proposalSha256(content),
			},
			content,
		});
	}
	return { strategy: 'git-working-tree', changes };
}

async function captureEntryNotebook(
	bucket: Bucket,
	sandbox: SandboxInstance,
	workdir: string,
	base: VersionPaths,
	source: NotebookProposal['source'],
): Promise<CapturedProposalChanges> {
	let content: Uint8Array;
	try {
		content = await readChangedFile(sandbox, workdir, source.entry_notebook);
	} catch (error) {
		if (!(error instanceof ConflictError)) throw error;
		throw new Error('Entry notebook inspection invariant failed', { cause: error });
	}
	const baseObject = await bucket.get(base.workspaceFile(source.entry_notebook));
	if (!baseObject) throw new NotFoundError('The synced entry notebook is missing');
	if (proposalBytesEqual(content, await baseObject.bytes())) {
		return { strategy: 'entry-notebook', changes: [] };
	}
	return {
		strategy: 'entry-notebook',
		changes: [
			{
				change: {
					path: source.entry_notebook,
					operation: 'modify',
					size_bytes: content.byteLength,
					sha256: await proposalSha256(content),
				},
				content,
			},
		],
	};
}

export async function captureProposalChanges(
	bucket: Bucket,
	sandbox: SandboxInstance,
	tree: GitWorkingTree,
	base: VersionPaths,
	source: NotebookProposal['source'],
): Promise<CapturedProposalChanges> {
	const normalized = {
		workdir: workingDirectory(tree.workdir),
		gitRoot: workingDirectory(tree.gitRoot),
	};
	return (
		(await captureGitWorkingTree(bucket, sandbox, normalized, base, source)) ??
		(await captureEntryNotebook(bucket, sandbox, normalized.workdir, base, source))
	);
}

/** The immutable hub tree remains authoritative even when the live Git index predates a save. */
export async function captureWorkingBranchChanges(
	bucket: Bucket,
	sandbox: SandboxInstance,
	tree: SandboxWorkspaceLayout,
	base: VersionPaths,
	check?: () => Promise<void>,
): Promise<CapturedProposalChanges & { baselineSizes: Map<string, number> }> {
	let renewedAt = 0;
	const renew = async () => {
		if (check && Date.now() - renewedAt >= 30_000) {
			await check();
			renewedAt = Date.now();
		}
	};
	await renew();
	if (!(await hasGitWorkingTree(sandbox, tree.gitRoot))) {
		throw new ConflictError('Working branch saves require a Git working tree');
	}
	await renew();
	const discovered = await sandbox.exec(
		gitInWorkdir(tree, `ls-files --cached --others --exclude-standard -z -- ${gitPathspec()}`),
	);
	if (!discovered.success) throw gitConflict('Could not inspect the Git working tree', discovered);
	await renew();
	const [objects, manifestObject] = await Promise.all([
		listAllObjects(bucket, base.workspacePrefix),
		bucket.get(base.workspaceManifest),
	]);
	const manifest = new Map(
		(manifestObject ? WorkspaceManifestSchema.parse(await manifestObject.json()) : []).map(
			(entry) => [entry.path, entry],
		),
	);
	const baseline = new Map(
		objects.map((object) => [object.key.slice(base.workspacePrefix.length), object]),
	);
	const candidates = new Set([
		...baseline.keys(),
		...parseNullTerminated(discovered.stdout, 'file list'),
	]);
	if (candidates.size > MAX_PROPOSAL_CHANGES * 2)
		throw new ValidationError('Working tree contains too many candidate paths');
	const paths = [...candidates].sort().filter((path) => {
		assertGitChangePath(path);
		return !isIgnoredPath(path);
	});
	const digests = await workingTreeDigests(sandbox, tree, paths, renew);
	const changes: CapturedProposalChange[] = [];
	let bytes = 0;
	for (const path of paths) {
		await renew();
		const previous = baseline.get(path);
		const digest = digests.get(path)!;
		if ('missing' in digest) {
			if (previous) changes.push({ change: { path, operation: 'delete' } });
		} else {
			if (previous?.size === digest.size_bytes) {
				let previousDigest = manifest.get(path)?.sha256;
				// Older immutable versions have no manifest; compare their bytes once per candidate.
				if (!previousDigest) {
					const object = await bucket.get(base.workspaceFile(path));
					if (!object) throw new ConflictError('Session baseline is unavailable');
					previousDigest = await proposalSha256(await object.bytes());
					await renew();
				}
				if (previousDigest === digest.sha256) continue;
			}
			bytes += digest.size_bytes;
			if (bytes > MAX_REQUEST_BYTES)
				throw new ValidationError('Working branch save exceeds the content limit');
			const content = await readGitChangedFile(sandbox, tree.gitRoot, digest.path, true);
			await renew();
			if (
				!content ||
				content.byteLength !== digest.size_bytes ||
				(await proposalSha256(content)) !== digest.sha256
			)
				throw new ConflictError('Working tree changed during capture; retry the save');
			changes.push({
				change: {
					path,
					operation: previous ? 'modify' : 'add',
					size_bytes: digest.size_bytes,
					sha256: digest.sha256,
				},
				content,
			});
		}
		if (changes.length > MAX_PROPOSAL_CHANGES)
			throw new ValidationError('Working branch save exceeds the file limit');
	}
	const baselineSizes = new Map([...baseline].map(([path, object]) => [path, object.size]));
	return { strategy: 'git-working-tree', changes, baselineSizes };
}
