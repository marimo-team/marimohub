import json
import base64
import os
from pathlib import Path
import subprocess
import sys
from collections import Counter

from logging_receiver import OtlpReceiver

directory, mode, command = sys.argv[1:]
proxy_requests = []
def respond(request):
    proxy_requests.append((request.path, request.headers.get('Host'), request.headers.get('Proxy-Authorization')))
    return False
server = OtlpReceiver(respond)
config_path = Path(directory, 'logging.json')
config = json.loads(config_path.read_text())
config[0]['url'] = server.url + '/v1/logs'
env = {**os.environ, 'MARIMOHUB_TEST_FORK_MODE': mode}
if mode in ('fork-proxy', 'fork-proxy-bypass', 'fork-proxy-env-cleared'):
    use_proxy = mode != 'fork-proxy-bypass'
    proxy = server.url.replace('://', '://proxy%2Duser:proxy%3Apassword@') if use_proxy else 'http://127.0.0.1:1'
    for key in ('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'):
        env[key] = proxy
    env['NO_PROXY'] = env['no_proxy'] = '127.0.0.1' if mode == 'fork-proxy-bypass' else ''
    if use_proxy:
        config[0]['url'] = 'http://fork-collector.invalid/v1/logs'
config_path.write_text(json.dumps(config))
Path('workload.py').write_text('''
import json, logging, multiprocessing, os, sys, threading
import marimohub_logging as bootstrap

mode = os.environ['MARIMOHUB_TEST_FORK_MODE']
parent_pid = os.getpid()
processor = bootstrap._processors[0]
release_export, entered_export = threading.Event(), threading.Event()
release_locks, entered_locks = threading.Event(), threading.Event()
holder = None

def child():
    if mode == 'fork-proxy-env-cleared':
        import urllib.request
        for key in list(os.environ):
            if key.lower().endswith('_proxy'):
                del os.environ[key]
        def unsafe_proxy_lookup(*args, **kwargs):
            raise AssertionError('native proxy discovery or bypass after fork')
        urllib.request.getproxies = unsafe_proxy_lookup
        urllib.request.proxy_bypass = unsafe_proxy_lookup
        urllib.request.getproxies_macosx_sysconf = unsafe_proxy_lookup
        urllib.request.proxy_bypass_macosx_sysconf = unsafe_proxy_lookup
        for scheme in ('http', 'https'):
            request = bootstrap.Request(scheme + '://collector.example:4318/v1/logs')
            bootstrap.configure_proxy(request, {scheme: 'http://proxy-user:proxy%3Apassword@[::1]:8080'})
            assert request.host == '[::1]:8080'
            assert request.get_header('Host') == 'collector.example:4318'
            assert request.get_header('Proxy-authorization') == 'Basic cHJveHktdXNlcjpwcm94eTpwYXNzd29yZA=='
            if scheme == 'https':
                assert request._tunnel_host == 'collector.example:4318'
    if mode == 'fork-initialization-failure':
        assert not bootstrap._processors
        assert not any(isinstance(h, bootstrap.Handler) for h in logging.getLogger().handlers)
        assert not any(t.name == 'marimohub-log-export' for t in threading.enumerate())
        logging.warning('fork-child-local-only')
        return
    assert bootstrap._pid == os.getpid() != parent_pid
    assert not bootstrap._stopped
    assert len(bootstrap._processors) == 1
    fresh = bootstrap._processors[0]
    assert fresh is not processor
    assert fresh.worker.is_alive()
    for logger in (logging.getLogger(), logging.getLogger('marimo')):
        handlers = [h for h in logger.handlers if isinstance(h, bootstrap.Handler)]
        assert len(handlers) == 1 and handlers[0].processor is fresh
    logging.info('fork-child-record')
    logging.getLogger('marimo').info('fork-child-marimo')

if mode == 'fork-locked-state':
    original_export = processor.export
    def blocked_export(batch):
        entered_export.set()
        assert release_export.wait(15)
        return original_export(batch)
    processor.export = blocked_export
logging.info('fork-parent-before')
if mode == 'fork-locked-state':
    assert entered_export.wait(5)
    logging.info('fork-parent-queued')
    def hold_locks():
        with processor.lock, processor.queue.mutex, processor.stop._cond, bootstrap._diagnostic_lock:
            entered_locks.set()
            release_locks.wait(15)
    holder = threading.Thread(target=hold_locks, daemon=True)
    holder.start()
    assert entered_locks.wait(5)
elif mode == 'fork-after-shutdown':
    bootstrap.shutdown()
elif mode == 'fork-initialization-failure':
    def fail(*args, **kwargs):
        raise RuntimeError('private-token')
    bootstrap.Processor = fail

try:
    if mode == 'raw-fork':
        child_pid = os.fork()
        if child_pid == 0:
            child()
            sys.exit(0)
        _, status = os.waitpid(child_pid, 0)
        assert os.waitstatus_to_exitcode(status) == 0, status
    else:
        process = multiprocessing.get_context('fork').Process(target=child)
        process.start()
        child_pid = process.pid
        process.join(8)
        if process.is_alive():
            process.kill()
            process.join(3)
            raise AssertionError('forked child blocked on inherited exporter state')
        assert process.exitcode == 0, process.exitcode
finally:
    release_locks.set()
    if holder is not None:
        holder.join(3)
    release_export.set()
logging.info('fork-parent-after')
bootstrap.shutdown()
print(json.dumps({'parent_pid': parent_pid, 'child_pid': child_pid}))
''')
try:
    result = subprocess.run(
        command, shell=True, text=True, capture_output=True, timeout=25,
        env=env,
    )
    assert result.returncode == 0, (result.stdout, result.stderr)
    assert 'private-token' not in result.stderr, result.stderr
    assert 'shutdown_timeout' not in result.stderr, result.stderr
    completed = json.loads(result.stdout)
    expected = Counter({('fork-parent-before', completed['parent_pid']): 1})
    if mode != 'fork-after-shutdown':
        expected[('fork-parent-after', completed['parent_pid'])] = 1
    if mode == 'fork-locked-state':
        expected[('fork-parent-queued', completed['parent_pid'])] = 1
    if mode == 'fork-initialization-failure':
        assert 'initialization_failed' in result.stderr, result.stderr
        assert 'fork-child-local-only' in result.stderr, result.stderr
    else:
        assert 'initialization_failed' not in result.stderr, result.stderr
        expected[('fork-child-record', completed['child_pid'])] = 1
        expected[('fork-child-marimo', completed['child_pid'])] = 1
    received = Counter(
        (body, attrs['process.pid']) for body, attrs, *_ in server.records if body.startswith('fork-')
    )
    assert received == expected, (received, expected, result.stderr)
    if mode in ('fork-proxy', 'fork-proxy-env-cleared'):
        assert proxy_requests
        expected_proxy_request = (
            'http://fork-collector.invalid/v1/logs', 'fork-collector.invalid',
            'Basic ' + base64.b64encode(b'proxy-user:proxy:password').decode(),
        )
        assert all(request == expected_proxy_request for request in proxy_requests), proxy_requests
finally:
    server.shutdown()
print(json.dumps({'ok': True, 'records': len(server.records)}))
