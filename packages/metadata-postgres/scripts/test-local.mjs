import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function pgBin() {
	if (process.env.PG_BINDIR) return process.env.PG_BINDIR;
	try {
		execFileSync('initdb', ['--version'], { stdio: 'ignore' });
		return '';
	} catch {
		try {
			return join(
				execFileSync('brew', ['--prefix', 'postgresql@17'], {
					encoding: 'utf8',
					stdio: ['ignore', 'pipe', 'ignore'],
				}).trim(),
				'bin',
			);
		} catch {
			throw new Error(
				'PostgreSQL 17+ binaries are required. Install postgresql@17 or set PG_BINDIR.',
			);
		}
	}
}

const binaryDir = pgBin();
const binary = (name) => (binaryDir ? join(binaryDir, name) : name);
const version = execFileSync(binary('postgres'), ['--version'], { encoding: 'utf8' }).trim();
const major = Number(/\b(\d+)\./.exec(version)?.[1]);
if (!Number.isInteger(major) || major < 17) throw new Error('PostgreSQL 17 or later is required');
const directory = await mkdtemp(join(tmpdir(), 'hub-pg-'));
const data = join(directory, 'data');
const passwordFile = join(directory, 'password');
const log = join(directory, 'postgres.log');
const password = randomBytes(24).toString('hex');
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
function stopCluster() {
	try {
		execFileSync(binary('pg_ctl'), ['-D', data, 'status'], { stdio: 'pipe' });
	} catch (error) {
		if (error.status === 3) return;
		throw error;
	}
	execFileSync(binary('pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { stdio: 'pipe' });
}
let started = false;
let startAttempted = false;
let child;
let signal;
const handlers = new Map(
	['SIGINT', 'SIGTERM'].map((name) => [
		name,
		() => {
			signal = name;
			// Terminate the test runner and its workers before the database is stopped.
			if (child?.pid) {
				try {
					process.kill(-child.pid, name);
				} catch (error) {
					if (error.code !== 'ESRCH') throw error;
				}
			}
		},
	]),
);
for (const [name, handler] of handlers) process.on(name, handler);
try {
	await writeFile(passwordFile, `${password}\n`, { mode: 0o600 });
	execFileSync(
		binary('initdb'),
		[
			'-D',
			data,
			'-U',
			'postgres',
			'--encoding=UTF8',
			'--locale=C',
			'--auth-local=scram-sha-256',
			'--auth-host=reject',
			`--pwfile=${passwordFile}`,
		],
		{ stdio: 'pipe' },
	);
	// A private Unix socket avoids TCP port conflicts and remote access.
	startAttempted = true;
	execFileSync(
		binary('pg_ctl'),
		['-D', data, '-l', log, '-o', `-h '' -k ${quote(directory)}`, '-w', 'start'],
		{ stdio: 'pipe' },
	);
	started = true;
	if (signal) throw new Error(`Interrupted by ${String(signal)}`);
	execFileSync(
		binary('psql'),
		[
			'-X',
			'-h',
			directory,
			'-U',
			'postgres',
			'-d',
			'postgres',
			'-v',
			'ON_ERROR_STOP=1',
			'-c',
			'SELECT 1',
		],
		{ env: { ...process.env, PGPASSWORD: password }, stdio: 'pipe' },
	);
	const url = new URL('postgresql://postgres@localhost/postgres');
	url.password = password;
	url.searchParams.set('host', directory);
	url.searchParams.set('port', '5432');
	process.stdout.write(`Running metadata tests with ${version} in a temporary local cluster.\n`);
	child = spawn('pnpm', ['test', ...process.argv.slice(2)], {
		cwd: dirname(dirname(fileURLToPath(import.meta.url))),
		stdio: 'inherit',
		detached: true,
		env: {
			...process.env,
			MARIMOHUB_REQUIRE_POSTGRES_TESTS: '1',
			MARIMOHUB_TEST_POSTGRES_URL: url.toString(),
		},
	});
	const code = await new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('close', (exitCode) => resolve(exitCode ?? 1));
	});
	process.exitCode = signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : code;
} catch (error) {
	console.error(error.message);
	if (!started) console.error(await readFile(log, 'utf8').catch(() => ''));
	process.exitCode = 1;
} finally {
	let stopped = !startAttempted;
	try {
		if (startAttempted) stopCluster();
		stopped = true;
	} catch {
		console.error(`Could not stop the test cluster. Data retained at ${directory}`);
		process.exitCode = 1;
	} finally {
		if (stopped) await rm(directory, { recursive: true, force: true });
		for (const [name, handler] of handlers) process.off(name, handler);
	}
}
