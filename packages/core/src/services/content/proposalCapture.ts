import { MAX_REQUEST_BYTES } from '../../constants';
import { ConflictError, NotFoundError, ValidationError } from '../../errors';
import { isSafeWorkspacePath } from '../../integrations/remoteWorkspace';
import type { Bucket } from '../../ports/bucket';
import type { FileInfo, SandboxInstance } from '../../ports/sandbox';
import type { NotebookProposal, ProposalChange } from '../../schema';
import type { VersionPaths } from '../../paths';
import { shellQuote } from '../runtime/shell';
import { decodeProposalContent, proposalBytesEqual, proposalSha256 } from './proposalUtils';

export const MAX_PROPOSAL_CHANGES = 1_000;

export interface CapturedProposalChange {
	change: ProposalChange;
	content?: Uint8Array;
}

export interface CapturedProposalChanges {
	strategy: NotebookProposal['capture_strategy'];
	changes: CapturedProposalChange[];
}

const IGNORED_DIRECTORY_NAMES = new Set([
	'.git',
	'.ipynb_checkpoints',
	'.mypy_cache',
	'.pytest_cache',
	'.ruff_cache',
	'.venv',
	'__marimo__',
	'__pycache__',
	'node_modules',
]);

const GIT_EXCLUDE_PATHS = [...IGNORED_DIRECTORY_NAMES].map(
	(name) => `:(exclude,glob)**/${name}/**`,
);
GIT_EXCLUDE_PATHS.push(':(exclude,glob)**/.DS_Store');

function isIgnoredPath(path: string): boolean {
	const segments = path.split('/');
	return (
		segments.some((segment) => IGNORED_DIRECTORY_NAMES.has(segment)) ||
		segments.at(-1) === '.DS_Store'
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

async function hasGitWorkingTree(sandbox: SandboxInstance, workdir: string): Promise<boolean> {
	const result = await sandbox.exec(
		`cd ${shellQuote(workdir)} && test -e .git && command -v git >/dev/null 2>&1 && printf git-working-tree`,
	);
	return result.success && result.stdout === 'git-working-tree';
}

async function resolvedGitBase(
	sandbox: SandboxInstance,
	workdir: string,
	commit: string,
): Promise<string> {
	const result = await sandbox.exec(
		`cd ${shellQuote(workdir)} && git rev-parse --verify ${shellQuote(`${commit}^{commit}`)}`,
	);
	if (!result.success) {
		throw new ConflictError('The Git working tree does not contain the pinned source commit');
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
	directoryListings: Map<string, readonly FileInfo[]> = new Map(),
): Promise<number> {
	const listDirectory = async (directory: string): Promise<readonly FileInfo[]> => {
		const cached = directoryListings.get(directory);
		if (cached) return cached;
		const listing = await sandbox.listFiles(directory, { includeHidden: true });
		if (!listing.success) throw new ConflictError(`Could not inspect changed file ${path}`);
		directoryListings.set(directory, listing.files);
		return listing.files;
	};
	const components = path.split('/');
	let parent = workdir;
	for (const component of components.slice(0, -1)) {
		const listing = await listDirectory(parent);
		const entry = listing.find((candidate) => candidate.name === component);
		if (!entry) throw new ConflictError(`Changed file ${path} is missing from the session`);
		if (entry.type !== 'directory') {
			throw new ConflictError(`Changed path ${path} has a non-directory parent`);
		}
		parent = sandboxPath(parent, component);
	}
	const name = components.at(-1) ?? '';
	const listing = await listDirectory(parent);
	const file = listing.find((candidate) => candidate.name === name);
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
	directoryListings: Map<string, readonly FileInfo[]>,
): Promise<Uint8Array> {
	await inspectRegularFile(sandbox, workdir, path, directoryListings);
	const result = await sandbox.exec(`base64 < ${shellQuote(sandboxPath(workdir, path))}`);
	if (!result.success) throw new ConflictError(`Could not read changed file ${path}`);
	const content = decodeProposalContent(result.stdout, 'base64');
	if (content.byteLength > MAX_REQUEST_BYTES) {
		throw new ValidationError(`Changed file ${path} exceeds the ${MAX_REQUEST_BYTES}-byte limit`);
	}
	return content;
}

async function captureGitWorkingTree(
	bucket: Bucket,
	sandbox: SandboxInstance,
	workdir: string,
	base: VersionPaths,
	source: NotebookProposal['source'],
): Promise<CapturedProposalChanges | null> {
	if (!(await hasGitWorkingTree(sandbox, workdir))) return null;
	const resolvedBase = await resolvedGitBase(sandbox, workdir, source.commit);
	const pathspec = gitPathspec();
	const [diff, untracked] = await Promise.all([
		sandbox.exec(
			`cd ${shellQuote(workdir)} && git diff --name-status -z --no-renames ${shellQuote(resolvedBase)} -- ${pathspec}`,
		),
		sandbox.exec(
			`cd ${shellQuote(workdir)} && git ls-files --others --exclude-standard -z -- ${pathspec}`,
		),
	]);
	if (!diff.success || !untracked.success) {
		throw new ConflictError('Could not inspect the Git working tree');
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
	const directoryListings = new Map<string, readonly FileInfo[]>();
	let totalBytes = 0;
	for (const [path, operation] of [...operations].sort(([left], [right]) =>
		left < right ? -1 : left > right ? 1 : 0,
	)) {
		const baseObject = operation === 'add' ? null : await bucket.get(base.workspaceFile(path));
		if (operation !== 'add' && !baseObject) {
			throw new ConflictError(`Changed file ${path} is missing from the synced source version`);
		}
		if (operation === 'delete') {
			changes.push({ change: { path, operation } });
			continue;
		}
		const content = await readGitChangedFile(sandbox, workdir, path, directoryListings);
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
	const content = await readChangedFile(sandbox, workdir, source.entry_notebook);
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
	workdirValue: string,
	base: VersionPaths,
	source: NotebookProposal['source'],
): Promise<CapturedProposalChanges> {
	const workdir = workingDirectory(workdirValue);
	return (
		(await captureGitWorkingTree(bucket, sandbox, workdir, base, source)) ??
		(await captureEntryNotebook(bucket, sandbox, workdir, base, source))
	);
}
