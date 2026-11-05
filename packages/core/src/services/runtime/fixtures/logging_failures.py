import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading
import time
from collections import Counter
from logging_receiver import OtlpReceiver

directory, mode, command = sys.argv[1:]
release = threading.Event()
initialization_failure = mode in ('invalid-json', 'missing-config', 'partial-config', 'partial-initialization', 'worker-start-failure')


def respond(request):
    if not request.path.startswith('/failed/'):
        return False
    if mode.startswith('http-'):
        request.send_response(int(mode.split('-')[1]), 'private-token')
    elif mode in ('partial-success', 'malformed-response', 'oversized-response'):
        body = {
            'partial-success': b'{"partialSuccess":{"rejectedLogRecords":"1","errorMessage":"private-token"}}',
            'malformed-response': b'private-token',
            'oversized-response': b' ' * (65 * 1024),
        }[mode]
        request.send_response(200)
        request.send_header('Content-Type', 'application/json')
        request.end_headers()
        try:
            request.wfile.write(body)
        except BrokenPipeError:
            pass
        return True
    elif mode in ('retry-after', 'retry-after-limit') and sum(path == request.path for path, _ in requests) == 1:
        request.send_response(429)
        request.send_header('Retry-After', '1' if mode == 'retry-after' else '60')
    elif mode == 'retry-success' and sum(path == request.path for path, _ in requests) == 1:
        request.send_response(503)
    elif mode == 'response-timeout':
        release.wait(10)
        return True
    elif mode == 'connection-reset':
        request.connection.shutdown(socket.SHUT_RDWR)
        request.connection.close()
        return True
    else:
        return False
    request.end_headers()
    return True


server = OtlpReceiver(respond, success_status=204 if mode == 'empty-success' else 200)
requests = server.requests
config_path = Path(directory, 'logging.json')
config = json.loads(config_path.read_text())
base = server.url
config[0]['url'] = base + '/failed/v1/logs'
config[0]['level'] = 'INFO'
config.append({**config[0], 'url': base + '/healthy/v1/logs', 'name': 'healthy', 'headers': {}})
refused = socket.socket()
if mode == 'connection-refused':
    # Reserve a port without listening, so another process cannot acquire it.
    refused.bind(('127.0.0.1', 0))
    config[0]['url'] = f'http://127.0.0.1:{refused.getsockname()[1]}/v1/logs'
elif mode == 'tls-error':
    config[0]['url'] = config[0]['url'].replace('http:', 'https:')
elif mode == 'partial-config':
    del config[1]['serviceName']
config_path.write_text(json.dumps(config))
if mode == 'invalid-json':
    config_path.write_text('{"secret": "private-token",')
elif mode == 'missing-config':
    config_path.unlink()

custom = Path('custom configuration')
custom.mkdir()
(custom / 'sitecustomize.py').write_text('')
env = {**os.environ, 'PYTHONPATH': str(custom.resolve()), 'OTEL_EXPORTER_OTLP_HEADERS': 'Authorization=ambient-secret'}
workload = "import logging\nlogging.error('fault-record')\nprint('workload-completed')\n"

if initialization_failure:
    if mode == 'partial-initialization':
        (custom / 'sitecustomize.py').write_text('''
import marimohub_logging as bootstrap
original = bootstrap.build_opener
created = 0
def fail(*args, **kwargs):
    global created
    created += 1
    if created == 2:
        raise RuntimeError('private-token')
    return original(*args, **kwargs)
bootstrap.build_opener = fail
''')
    if mode == 'worker-start-failure':
        (custom / 'sitecustomize.py').write_text('''
import threading
original = threading.Thread.start
started = 0
def fail(self):
    global started
    if self.name == 'marimohub-log-export':
        started += 1
        if started == 2:
            raise RuntimeError('private-token')
    return original(self)
threading.Thread.start = fail
''')
    workload = '''
import logging, threading
assert logging.getLogger().level == logging.WARNING
assert not any(h.__class__.__module__ == 'marimohub_logging' for h in logging.getLogger().handlers)
assert not any(t.name == 'marimohub-log-export' for t in threading.enumerate())
assert not any(f.__class__.__module__ == 'marimohub_logging' for f in logging.getLogger('opentelemetry.exporter.otlp.proto.http._log_exporter').filters)
logging.warning('still-running')
print('workload-completed')
'''
elif mode in ('missing-level-hook', 'missing-sigterm-hook', 'missing-both-hooks', 'unavailable-marimo'):
    env['MARIMOHUB_TEST_HOOK_FAILURE'] = mode
    (custom / 'sitecustomize.py').write_text('''
import os, sys
mode = os.environ['MARIMOHUB_TEST_HOOK_FAILURE']
if mode == 'unavailable-marimo':
    sys.modules['marimo'] = None
else:
    from marimo import _loggers
    from marimo._runtime import handlers
    if mode in ('missing-level-hook', 'missing-both-hooks'):
        del _loggers.set_level
    if mode in ('missing-sigterm-hook', 'missing-both-hooks'):
        del handlers.construct_sigterm_handler
''')
    workload = '''
import logging, os, sys
import marimohub_logging as bootstrap
mode = os.environ['MARIMOHUB_TEST_HOOK_FAILURE']
assert len(bootstrap._processors) == 2
if mode == 'missing-sigterm-hook':
    from marimo import _loggers
    _loggers.set_level(logging.CRITICAL)
    assert logging.getLogger('marimo').level == logging.INFO
logging.getLogger('marimo').error('marimo-record')
logging.error('fault-record')
print('workload-completed', flush=True)
if mode == 'missing-level-hook':
    from types import SimpleNamespace
    from marimo._runtime import handlers
    handlers.get_context = lambda: SimpleNamespace(virtual_file_registry=SimpleNamespace(shutdown=lambda: None))
    handlers.construct_sigterm_handler(None)(15, None)
'''
elif mode == 'response-timeout':
    workload = '''
import logging, time
started = time.monotonic()
logging.error('fault-record')
assert time.monotonic() - started < 1, 'logging waited for the network'
print('workload-completed')
'''
elif mode == 'shutdown-deadline':
    workload = '''
import logging, threading, time
import marimohub_logging as bootstrap
entered = [threading.Event() for p in bootstrap._processors]
never = threading.Event()
for processor, event in zip(bootstrap._processors, entered):
    def hang(batch, event=event):
        event.set()
        never.wait(30)
    processor.export = hang
logging.error('fault-record')
assert all(event.wait(5) for event in entered)
started = time.monotonic()
bootstrap.shutdown()
assert 2.5 <= time.monotonic() - started < 4.5
started = time.monotonic()
bootstrap.shutdown()
assert time.monotonic() - started < 0.2
print('workload-completed')
'''
elif mode == 'exporter-exception':
    workload = '''
import logging
import marimohub_logging as bootstrap
def fail(batch):
    raise RuntimeError('private-token')
bootstrap._processors[0].export = fail
logging.error('fault-record')
print('workload-completed')
'''
elif mode == 'record-encoding':
    workload = '''
import logging
logging.info('%d', 'not-a-number')
logging.error('fault-record')
print('workload-completed')
'''
elif mode == 'sitecustomize-failure':
    (custom / 'sitecustomize.py').write_text("raise RuntimeError('private-token')\n")
elif mode == 'existing-handler':
    (custom / 'sitecustomize.py').write_text('''
import builtins, io, logging
builtins.local_output = io.StringIO()
builtins.local_handler = logging.StreamHandler(builtins.local_output)
builtins.local_handler.setLevel(logging.ERROR)
logging.getLogger().addHandler(builtins.local_handler)
''')
    workload = '''
import builtins, logging
assert builtins.local_handler in logging.getLogger().handlers
assert builtins.local_handler.level == logging.ERROR
logging.info('remote-only')
logging.error('fault-record')
assert builtins.local_output.getvalue() == 'fault-record\\n'
print('workload-completed')
'''
elif mode == 'concurrent-records':
    workload = """
import logging
from concurrent.futures import ThreadPoolExecutor
def emit(worker):
    for index in range(50):
        logging.info('thread:%d:%d', worker, index)
with ThreadPoolExecutor(max_workers=6) as pool:
    list(pool.map(emit, range(6)))
logging.error('fault-record')
print('workload-completed')
"""
elif mode == 'unicode-records':
    workload = """
import logging
logging.info('Δεδομένα 日本語 🚀', extra={'dataset': 'café', 'rows': 123, 'ready': True})
logging.error('fault-record')
print('workload-completed')
"""
elif mode == 'netrc':
    Path('credentials.netrc').write_text('machine 127.0.0.1 login ambient password ambient-secret\n')
    env['NETRC'] = str(Path('credentials.netrc').resolve())

Path('workload.py').write_text(workload)
started = time.monotonic()
try:
    result = subprocess.run(command, shell=True, env=env, capture_output=True, text=True, timeout=15)
finally:
    release.set()
    refused.close()
    server.shutdown()
stdout, stderr = result.stdout, result.stderr
assert result.returncode == 0, (stdout, stderr)
assert 'workload-completed' in stdout, stdout
assert 'private-token' not in stderr, stderr
assert 'ambient-secret' not in stderr, stderr
assert 'Exception in thread' not in stderr, stderr
assert time.monotonic() - started < 10, 'export blocked notebook exit'
assert not Path('unexpected').exists()
counts = Counter((body, attrs['marimohub.integration']) for body, attrs, *_ in server.records)
failed_requests = [r for r in requests if r[0].startswith('/failed/')]
diagnostics = [json.loads(line) for line in stderr.splitlines() if line.startswith('{')]

if mode in ('missing-level-hook', 'missing-sigterm-hook', 'missing-both-hooks', 'unavailable-marimo'):
    assert 'initialization_failed' not in stderr, stderr
    expected = {'marimo_level_hook_failed', 'marimo_sigterm_hook_failed'}
    if mode == 'missing-level-hook':
        expected = {'marimo_level_hook_failed'}
    elif mode == 'missing-sigterm-hook':
        expected = {'marimo_sigterm_hook_failed'}
    assert {d['reason'] for d in diagnostics} == expected, diagnostics
    assert counts[('marimo-record', 'healthy')] == counts[('marimo-record', 'logs')] == 1, counts

if initialization_failure:
    assert 'initialization_failed' in stderr, stderr
    assert requests == [], requests
elif mode == 'shutdown-deadline':
    timeouts = [d for d in diagnostics if d['reason'] == 'shutdown_timeout']
    assert {d['destination'] for d in timeouts} == {'logs', 'healthy'}, diagnostics
    assert all(d['dropped_records'] == 1 for d in timeouts), diagnostics
else:
    assert counts[('fault-record', 'healthy')] == 1, (counts, stderr)
    if mode.startswith('http-') or mode in ('connection-refused', 'response-timeout', 'connection-reset', 'tls-error', 'exporter-exception', 'partial-success', 'malformed-response', 'oversized-response', 'retry-after-limit'):
        assert counts[('fault-record', 'logs')] == 0, counts
        reasons = ('delivery_failed_or_queue_full', 'shutdown_timeout') if mode == 'connection-refused' else ('delivery_failed_or_queue_full',)
        assert any(d['reason'] in reasons and d.get('destination') == 'logs' and d.get('dropped_records') == 1 for d in diagnostics), diagnostics
        assert len(failed_requests) <= 4, requests
        if mode in ('http-400', 'http-401', 'http-403', 'http-500', 'partial-success', 'malformed-response', 'oversized-response', 'retry-after-limit'):
            assert len(failed_requests) == 1, requests
    else:
        assert counts[('fault-record', 'logs')] == 1, (counts, stderr)
        assert not any(d['reason'] in ('delivery_failed_or_queue_full', 'shutdown_timeout') for d in diagnostics), diagnostics
        if mode == 'retry-success':
            assert len(failed_requests) == 2, requests
        elif mode == 'retry-after':
            assert len(failed_requests) == 2, requests
            times = [t for (path, _), t in zip(requests, server.request_times) if path.startswith('/failed/')]
            assert times[1] - times[0] >= 1, times
        elif mode == 'record-encoding':
            assert 'record_encoding_failed' in stderr, stderr
        elif mode == 'sitecustomize-failure':
            assert 'sitecustomize_failed' in stderr, stderr
        elif mode == 'concurrent-records':
            expected = Counter((f'thread:{worker}:{index}', name) for worker in range(6) for index in range(50) for name in ('logs', 'healthy'))
            assert Counter({key: value for key, value in counts.items() if key[0].startswith('thread:')}) == expected
        elif mode == 'unicode-records':
            assert counts[('Δεδομένα 日本語 🚀', 'logs')] == 1
            assert counts[('Δεδομένα 日本語 🚀', 'healthy')] == 1

for path, auth in requests:
    assert auth == ('Bearer private-token' if path.startswith('/failed/') else None), requests
print(json.dumps({'ok': True, 'records': len(server.records)}))
