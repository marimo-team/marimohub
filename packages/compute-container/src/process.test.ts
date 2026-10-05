import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, it } from 'vitest';
import { KILL_PROCESS, START_PROCESS, SUPERVISE_PROCESS } from './process';

const run = promisify(execFile);

async function python(program: string, assertions: string): Promise<void> {
	await run('python3', [
		'-c',
		`
import io, json, signal, sys
from unittest.mock import Mock, mock_open, patch
program = json.loads(sys.argv[1])
stat = '123 (name (with spaces)) ' + ' '.join(['S'] + ['0'] * 18 + ['456'])
${assertions}
`,
		JSON.stringify(program),
	]);
}

describe('container process scripts', () => {
	it('adopts and reaps descendants until the group has no remaining children', async () => {
		await python(
			SUPERVISE_PROCESS,
			`
with patch('ctypes.CDLL') as library, patch('signal.signal') as handler, \
     patch('subprocess.Popen') as spawn, \
     patch('os.wait', side_effect=[(123, 0), InterruptedError(), (456, 0), ChildProcessError()]) as wait, \
     patch.object(sys, 'argv', ['supervise', 'run-surface']):
    library.return_value.prctl.return_value = 0
    exec(program, {})
    library.return_value.prctl.assert_called_once_with(36, 1, 0, 0, 0)
    spawn.assert_called_once_with(['sh', '-lc', 'run-surface'])
    assert wait.call_count == 4
    signals = {call.args[0] for call in handler.call_args_list}
    assert signals == {signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGQUIT, signal.SIGUSR1, signal.SIGUSR2}
    for call in handler.call_args_list:
        assert callable(call.args[1]), 'SIG_IGN would also make children ignore termination'
        assert call.args[1](call.args[0], None) is None
`,
		);
	});

	it('replays a termination signal received before the command has spawned', async () => {
		await python(
			SUPERVISE_PROCESS,
			`
handlers = {}
def spawn(*args):
    handlers[signal.SIGTERM](signal.SIGTERM, None)
    return Mock(pid=123)
with patch('ctypes.CDLL') as library, \
     patch('signal.signal', side_effect=lambda sig, handler: handlers.__setitem__(sig, handler)), \
     patch('subprocess.Popen', side_effect=spawn), patch('os.getpgrp', return_value=456), \
     patch('os.killpg', side_effect=lambda group, sig: handlers[sig](sig, None)) as kill, \
     patch('os.wait', side_effect=ChildProcessError()), \
     patch.object(sys, 'argv', ['supervise', 'run-surface']):
    library.return_value.prctl.return_value = 0
    exec(program, {})
    kill.assert_called_once_with(456, signal.SIGTERM)
`,
		);
	});

	it.each(['subreaper unavailable', 'spawn failed', 'wait failed'])(
		'reports supervisor failure when %s',
		async (scenario) => {
			await python(
				SUPERVISE_PROCESS,
				`
scenario = '${scenario}'
with patch('ctypes.CDLL') as library, patch('ctypes.get_errno', return_value=13), \
     patch('signal.signal'), patch('subprocess.Popen') as spawn, patch('os.wait') as wait, \
     patch.object(sys, 'argv', ['supervise', 'run-surface']):
    library.return_value.prctl.return_value = -1 if scenario == 'subreaper unavailable' else 0
    if scenario == 'spawn failed': spawn.side_effect = OSError('fork failed')
    wait.side_effect = OSError('wait failed')
    try:
        exec(program, {})
        raise AssertionError('supervision failure was swallowed')
    except OSError:
        pass
    if scenario == 'subreaper unavailable': spawn.assert_not_called()
    if scenario != 'wait failed': wait.assert_not_called()
`,
			);
		},
	);

	it.each(['TERM', 'SIGTERM', 'SIGKILL'])(
		'signals the recorded process group with %s',
		async (sig) => {
			await python(
				KILL_PROCESS,
				`
with patch('builtins.open', side_effect=[io.StringIO('123 456'), io.StringIO(stat)]) as opened, \
     patch('os.killpg') as kill, patch.object(sys, 'argv', ['kill', '/record', '${sig}']):
    exec(program, {})
    assert opened.call_args_list[1].args == ('/proc/123/stat',)
    kill.assert_called_once_with(123, signal.${sig.startsWith('SIG') ? sig : `SIG${sig}`})
`,
			);
		},
	);

	it.each(['missing record', 'exited process', 'reused PID', 'exit during signal'])(
		'handles %s without signaling another process',
		async (scenario) => {
			await python(
				KILL_PROCESS,
				`
scenario = '${scenario}'
reads = [io.StringIO('123 456'), io.StringIO(stat)]
if scenario == 'missing record': reads = [FileNotFoundError()]
if scenario == 'exited process': reads[1] = FileNotFoundError()
if scenario == 'reused PID': reads[0] = io.StringIO('123 455')
with patch('builtins.open', side_effect=reads), patch('os.killpg') as kill, \
     patch.object(sys, 'argv', ['kill', '/record', 'SIGTERM']):
    if scenario == 'exit during signal': kill.side_effect = ProcessLookupError()
    exec(program, {})
    if scenario == 'exit during signal': kill.assert_called_once_with(123, signal.SIGTERM)
    else: kill.assert_not_called()
`,
			);
		},
	);

	it.each(['corrupt record', 'unreadable record', 'signal denied', 'invalid signal'])(
		'reports %s instead of claiming successful cleanup',
		async (scenario) => {
			await python(
				KILL_PROCESS,
				`
scenario = '${scenario}'
reads = [io.StringIO('123 456'), io.StringIO(stat)]
if scenario == 'corrupt record': reads[0] = io.StringIO('invalid')
if scenario == 'unreadable record': reads[0] = PermissionError()
sig = 'INVALID' if scenario == 'invalid signal' else 'SIGTERM'
with patch('builtins.open', side_effect=reads), patch('os.killpg') as kill, \
     patch.object(sys, 'argv', ['kill', '/record', sig]):
    if scenario == 'signal denied': kill.side_effect = PermissionError()
    try:
        exec(program, {})
        raise AssertionError('cleanup failure was swallowed')
    except (ValueError, PermissionError, AttributeError):
        pass
    if scenario != 'signal denied': kill.assert_not_called()
`,
			);
		},
	);

	it('starts a separate process group and records its identity before returning', async () => {
		await python(
			START_PROCESS,
			`
child = Mock(pid=123)
opened = mock_open()
opened.side_effect = lambda path, *args: io.StringIO(stat) if path == '/proc/123/stat' else opened.return_value
with patch('builtins.open', opened), patch('subprocess.Popen', return_value=child) as spawn, \
     patch.object(sys, 'argv', ['start', '/record', '/log', 'run-surface']):
    exec(program, {})
    assert spawn.call_args.args[0][0:2] == [sys.executable, '-c']
    assert 'PR_SET_CHILD_SUBREAPER' in spawn.call_args.args[0][2]
    assert spawn.call_args.args[0][3] == 'run-surface'
    assert spawn.call_args.kwargs['start_new_session'] is True
    opened.return_value.write.assert_called_once_with('123 456')
`,
		);
	});

	it.each([
		'record denied',
		'record directory missing',
		'record write failed',
		'identity unreadable',
	])('kills and reaps the new process when %s', async (scenario) => {
		await python(
			START_PROCESS,
			`
scenario = '${scenario}'
child = Mock(pid=123)
record = mock_open()
record().write.side_effect = OSError('disk full')
failure = FileNotFoundError() if scenario == 'record directory missing' else PermissionError()
last_open = record.return_value if scenario == 'record write failed' else failure
reads = [io.StringIO(), io.StringIO(stat), last_open]
if scenario == 'identity unreadable': reads[1] = PermissionError()
with patch('builtins.open', side_effect=reads), \
     patch('subprocess.Popen', return_value=child), patch('os.killpg') as kill, \
     patch.object(sys, 'argv', ['start', '/record', '/log', 'run-surface']):
    try:
        exec(program, {})
        raise AssertionError('record failure was swallowed')
    except OSError:
        pass
    kill.assert_called_once_with(123, signal.SIGKILL)
    child.wait.assert_called_once_with()
`,
		);
	});

	it.each(['log denied', 'spawn failed'])(
		'reports %s without creating a process record',
		async (scenario) => {
			await python(
				START_PROCESS,
				`
with patch('builtins.open', mock_open()) as opened, patch('subprocess.Popen') as spawn, \
     patch('os.killpg') as kill, patch.object(sys, 'argv', ['start', '/record', '/log', 'run-surface']):
    if '${scenario}' == 'log denied': opened.side_effect = PermissionError()
    else: spawn.side_effect = OSError('fork failed')
    try:
        exec(program, {})
        raise AssertionError('start failure was swallowed')
    except OSError:
        pass
    opened.assert_called_once_with('/log', 'w')
    kill.assert_not_called()
    if '${scenario}' == 'log denied': spawn.assert_not_called()
`,
			);
		},
	);

	it('tolerates a process that exits before its identity can be recorded', async () => {
		await python(
			START_PROCESS,
			`
with patch('builtins.open', side_effect=[io.StringIO(), FileNotFoundError()]) as opened, \
     patch('subprocess.Popen', return_value=Mock(pid=123)), patch('os.killpg') as kill, \
     patch.object(sys, 'argv', ['start', '/record', '/log', 'false']):
    exec(program, {})
    assert opened.call_count == 2
    kill.assert_not_called()
`,
		);
	});
});
