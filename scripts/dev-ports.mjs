import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const vpBin = fileURLToPath(new URL('./bin/vp', import.meta.resolve('vite-plus/package.json')));
const args = [
	'run',
	'--filter',
	'@marimo-hub/server',
	'--filter',
	'@marimo-hub/web',
	'--parallel',
	'--log',
	'labeled',
	'dev',
];

const env = { ...process.env };
const base = env.DEV_PORT_BASE;

if (base !== undefined && base !== '') {
	const basePort = Number(base);
	if (!Number.isInteger(basePort) || basePort < 1 || basePort >= 65_535) {
		console.error('DEV_PORT_BASE must be an integer between 1 and 65534.');
		process.exitCode = 1;
	} else {
		env.PORT ||= String(basePort);
		env.WEB_PORT ||= String(basePort + 1);
	}
}

if (process.exitCode === undefined) {
	const useProcessGroup = process.platform !== 'win32';
	const child = spawn(process.execPath, [vpBin, ...args], {
		detached: useProcessGroup,
		env,
		stdio: 'inherit',
	});
	const signals = useProcessGroup
		? ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM']
		: ['SIGINT', 'SIGTERM'];
	const signalHandlers = new Map();
	const signalChildTree = (signal, groupMayBeGone = false) => {
		if (!useProcessGroup || child.pid === undefined) {
			child.kill(signal);
			return;
		}

		try {
			process.kill(-child.pid, signal);
		} catch (error) {
			if (error.code !== 'ESRCH' && !(groupMayBeGone && error.code === 'EPERM')) {
				throw error;
			}
		}
	};
	const removeSignalHandlers = () => {
		for (const [signal, handler] of signalHandlers) {
			process.removeListener(signal, handler);
		}
	};

	for (const signal of signals) {
		const handler = () => signalChildTree(signal);
		signalHandlers.set(signal, handler);
		process.on(signal, handler);
	}

	child.on('error', (error) => {
		removeSignalHandlers();
		console.error(error);
		process.exitCode = 1;
	});
	child.on('exit', (code, signal) => {
		if (useProcessGroup) {
			signalChildTree('SIGTERM', true);
		}
		removeSignalHandlers();
		if (signal) {
			process.kill(process.pid, signal);
		} else {
			process.exitCode = code ?? 1;
		}
	});
}
