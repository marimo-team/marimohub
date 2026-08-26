import { MAX_WORKSPACE_FILE_BYTES } from '../../constants';
import { MAX_DECOMPRESSED_ARCHIVE_BYTES } from '../../integrations/workspaceArchive';
import type { Bucket } from '../../ports/bucket';
import { MAX_GIT_DIRECTORY_BYTES, MAX_GIT_DIRECTORY_FILES } from '../../ports/sourceControl';
import type { SandboxInstance } from '../../ports/sandbox';
import { shellQuote } from './shell';

const MAX_WORKSPACE_FILES = 1000;
// Valid workspace and Git trees top out at 200 MiB; the remainder covers ZIP metadata.
const MAX_PACKED_ARCHIVE_BYTES = 256 * 1024 * 1024;

export const EXTRACT_PACKED_WORKSPACE = String.raw`
import os
import shutil
import stat
import sys
import zipfile

archive, temporary_root, destination, require_git_value = sys.argv[1:]
require_git = require_git_value == '1'
workspace_file_limit = ${MAX_WORKSPACE_FILES}
workspace_byte_limit = ${MAX_DECOMPRESSED_ARCHIVE_BYTES}
git_file_limit = ${MAX_GIT_DIRECTORY_FILES}
git_byte_limit = ${MAX_GIT_DIRECTORY_BYTES}
per_file_limit = ${MAX_WORKSPACE_FILE_BYTES}

def fail(message):
    raise ValueError(message)

def group_for(name):
    return 'git' if require_git and name.startswith('.git/') else 'workspace'

def check_limit(group, count, size):
    file_limit = git_file_limit if group == 'git' else workspace_file_limit
    byte_limit = git_byte_limit if group == 'git' else workspace_byte_limit
    if count > file_limit or size > byte_limit:
        fail('archive limits exceeded')

exit_code = 0
try:
    destination = os.path.abspath(destination)
    temporary_root = os.path.abspath(temporary_root)
    staging = os.path.join(temporary_root, 'tree')
    temporary_name = os.path.basename(temporary_root)
    if (
        destination == os.path.abspath(os.sep)
        or os.path.dirname(temporary_root) != destination
        or not os.path.isdir(destination)
        or os.path.islink(destination)
    ):
        fail('unsafe extraction destination')
    shutil.rmtree(staging, ignore_errors=True)
    os.makedirs(staging)
    staging_prefix = staging + os.sep
    declared_counts = {'workspace': 0, 'git': 0}
    declared_bytes = {'workspace': 0, 'git': 0}
    seen = set()
    infos = []
    with zipfile.ZipFile(archive) as packed:
        for info in packed.infolist():
            name = info.filename
            if info.flag_bits & 1 or info.is_dir():
                fail('unsupported archive entry')
            if not name or name.startswith('/') or '\\' in name or '\x00' in name:
                fail('unsafe archive path')
            parts = name.split('/')
            if any(not part or part in ('.', '..') for part in parts) or name in seen:
                fail('unsafe or duplicate archive path')
            if parts[0] == temporary_name:
                fail('archive path conflicts with restore files')
            mode = (info.external_attr >> 16) & 0xFFFF
            file_type = stat.S_IFMT(mode)
            if file_type not in (0, stat.S_IFREG):
                fail('special archive entry')
            if info.file_size < 0 or info.file_size > per_file_limit:
                fail('archive file limit exceeded')
            group = group_for(name)
            declared_counts[group] += 1
            declared_bytes[group] += info.file_size
            check_limit(group, declared_counts[group], declared_bytes[group])
            target = os.path.abspath(os.path.join(staging, *parts))
            if not target.startswith(staging_prefix):
                fail('unsafe archive path')
            seen.add(name)
            infos.append((info, target, group))

        if require_git and '.git/HEAD' not in seen:
            fail('Git metadata is incomplete')
        if not infos:
            fail('archive is empty')

        actual_counts = {'workspace': 0, 'git': 0}
        actual_bytes = {'workspace': 0, 'git': 0}
        for info, target, group in infos:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            file_bytes = 0
            with packed.open(info) as source, open(target, 'xb') as output:
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    file_bytes += len(chunk)
                    actual_bytes[group] += len(chunk)
                    if file_bytes > per_file_limit:
                        fail('archive file limit exceeded')
                    check_limit(group, actual_counts[group] + 1, actual_bytes[group])
                    output.write(chunk)
            if file_bytes != info.file_size:
                fail('archive file size mismatch')
            actual_counts[group] += 1

    if set(os.listdir(destination)) != {temporary_name}:
        fail('workspace is not empty')
    for name in os.listdir(staging):
        os.replace(os.path.join(staging, name), os.path.join(destination, name))
except Exception as error:
    print(
        'packed workspace extraction failed: ' + type(error).__name__ + ': ' + str(error),
        file=sys.stderr,
    )
    exit_code = 1
finally:
    try:
        shutil.rmtree(temporary_root)
    except FileNotFoundError:
        pass
    except Exception as error:
        print('packed workspace cleanup failed: ' + type(error).__name__, file=sys.stderr)
        exit_code = 1

raise SystemExit(exit_code)
`.trimStart();

export type PackedWorkspaceRestoreResult =
	| { status: 'missing' }
	| { status: 'restored'; archiveBytes: number }
	| { status: 'failed'; error: unknown };

function normalizeWorkingDir(workingDir: string): string {
	const normalized = workingDir.replace(/\/+$/, '');
	const parts = normalized.slice(1).split('/');
	if (
		!normalized.startsWith('/') ||
		normalized === '' ||
		normalized.includes('\\') ||
		normalized.includes('\0') ||
		parts.some((part) => part === '' || part === '.' || part === '..')
	) {
		throw new Error('Packed workspace restore requires a non-root absolute working directory');
	}
	return normalized;
}

export async function restorePackedWorkspace(
	sandbox: SandboxInstance,
	bucket: Bucket,
	archiveKey: string,
	workingDir: string,
	requireGit: boolean,
): Promise<PackedWorkspaceRestoreResult> {
	let cleanup: (() => Promise<unknown>) | undefined;
	try {
		const normalizedWorkingDir = normalizeWorkingDir(workingDir);
		const temporaryRoot = `${normalizedWorkingDir}/.marimohub-packed-restore`;
		const archivePath = `${temporaryRoot}/workspace.zip`;
		const scriptPath = `${temporaryRoot}/extract.py`;
		cleanup = () => sandbox.exec(`rm -rf -- ${shellQuote(temporaryRoot)}`);
		const object = await bucket.get(archiveKey);
		if (!object) return { status: 'missing' };
		if (object.size > MAX_PACKED_ARCHIVE_BYTES) {
			throw new Error('Packed workspace archive exceeds the transport limit');
		}
		const archive = await object.bytes();
		if (archive.byteLength !== object.size) {
			throw new Error('Packed workspace archive size changed while reading');
		}
		await sandbox.writeFiles([
			{ path: archivePath, content: archive },
			{ path: scriptPath, content: EXTRACT_PACKED_WORKSPACE },
		]);
		const result = await sandbox.exec(
			`python3 ${shellQuote(scriptPath)} ${shellQuote(archivePath)} ${shellQuote(temporaryRoot)} ${shellQuote(normalizedWorkingDir)} ${requireGit ? '1' : '0'}`,
		);
		if (!result.success) {
			const detail = result.stderr.trim().slice(-2000);
			throw new Error(
				detail
					? `Packed workspace extraction failed: ${detail}`
					: 'Packed workspace extraction failed',
			);
		}
		return { status: 'restored', archiveBytes: archive.byteLength };
	} catch (error) {
		await cleanup?.().catch(() => {});
		return { status: 'failed', error };
	}
}
