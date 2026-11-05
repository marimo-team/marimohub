import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.request import Request, urlopen
from html.parser import HTMLParser

from logging_receiver import OtlpReceiver
from websockets.sync.client import connect

directory, mode, command = sys.argv[1:]

def respond(request):
    if mode == 'failure':
        request.send_response(503)
    elif mode == 'redirect':
        request.send_response(307)
        request.send_header('Location', f'http://localhost:{request.server.server_port}/redirected')
    else:
        return False
    request.end_headers()
    return True


server = OtlpReceiver(respond)
received, requests = server.records, server.requests
config_path = Path(directory, 'logging.json')
config = json.loads(config_path.read_text())
config[0]['url'] = server.url + '/v1/logs'
config.append({**config[0], 'name': 'second', 'level': 'ERROR', 'headers': {}})
config_path.write_text(json.dumps(config))

Path('custom').mkdir()
Path('custom/sitecustomize.py').write_text('import builtins\nbuiltins.hub_customization = True\n')
env = {**os.environ, 'PYTHONPATH': str(Path('custom').resolve()), 'OTEL_EXPORTER_OTLP_HEADERS': 'Authorization=ambient-secret'}
Path('workload.py').write_text('''
import builtins, logging, multiprocessing, os, sys
assert builtins.hub_customization

def worker():
    logging.info('spawn-record')

if __name__ == '__main__':
    import marimohub_logging as bootstrap
    bootstrap.install()
    bootstrap.install()
    from marimo import _loggers
    _loggers.set_level(logging.WARNING)
    logger = logging.getLogger('marimo')
    logger.debug('marimo-debug')
    logger.propagate = True
    logger.error('one-record-per-destination')
    logging.info('parent-record')
    import io
    from contextlib import redirect_stderr
    local = io.StringIO()
    with redirect_stderr(local):
        logging.warning('local-warning')
        logging.info('remote-info')
    assert 'local-warning' in local.getvalue()
    assert 'remote-info' not in local.getvalue()
    try:
        raise ValueError('test-error')
    except ValueError:
        logging.exception('exception-record')
    child = multiprocessing.get_context('spawn').Process(target=worker)
    child.start()
    child.join(10)
    assert child.exitcode == 0
''')
if mode in ('failure', 'redirect'):
    Path('workload.py').write_text("import logging\nlogging.warning('failure-record')\nprint('workload-completed')\n")
elif mode == 'kernel-exit':
    Path('workload.py').write_text("""
import logging
from types import SimpleNamespace
from marimo._runtime import handlers
handlers.get_context = lambda: SimpleNamespace(virtual_file_registry=SimpleNamespace(shutdown=lambda: None))
logging.info('kernel-final-record')
handlers.construct_sigterm_handler(None)(15, None)
""")
elif mode == 'initialization-failure':
    Path('custom/sitecustomize.py').write_text("import sys\nsys.modules['opentelemetry'] = None\n")
    Path('workload.py').write_text("print('workload-completed')\n")
elif mode == 'overflow':
    Path('workload.py').write_text('''
import logging, threading
import marimohub_logging as bootstrap
from opentelemetry.sdk._logs.export import LogRecordExportResult
processor = bootstrap._processors[0]
entered, release = threading.Event(), threading.Event()
def block(batch):
    entered.set()
    release.wait(10)
    return LogRecordExportResult.SUCCESS
processor.exporter.export = block
logging.info('block-export')
assert entered.wait(5)
for i in range(2200):
    logging.info('queued-%d', i)
assert processor.queue.qsize() == 2048
assert processor.dropped > 0
release.set()
bootstrap.shutdown()
''')
elif mode == 'disabled':
    Path('workload.py').write_text("import logging, sys\nassert 'marimohub_logging' not in sys.modules\nlogging.warning('disabled')\n")

Path('notebook.py').write_text('''
import marimo
app = marimo.App()
@app.cell
def _():
    import logging
    logging.info('notebook-record')
    return
if __name__ == '__main__':
    app.run()
''')
Path('pyproject.toml').write_text('[project]\nname = "logging-test"\nversion = "0.0.0"\nrequires-python = ">=3.12"\n')
Path('.marimo.toml').write_text('[runtime]\nauto_instantiate = true\n')
# Use one socket through startup instead of racing another process for a free port.
Path('server.py').write_text('''
import socket, sys
if __name__ == '__main__':
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    print(sock.getsockname()[1], flush=True)
    import uvicorn
    original = uvicorn.Server.run
    uvicorn.Server.run = lambda self: original(self, sockets=[sock])
    sys.argv[0] = 'marimo'
    sys.argv[sys.argv.index('--port') + 1] = str(sock.getsockname()[1])
    from marimo._cli.cli import main
    main(prog_name='marimo')
''')

started = time.monotonic()
if mode in ('edit', 'app'):
    command = command.replace('python -m marimo', 'python server.py')
    process = subprocess.Popen(command, shell=True, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        line = process.stdout.readline().strip()
        assert line, process.stderr.read()
        port = int(line)
        base = f'http://127.0.0.1:{port}'
        deadline = time.monotonic() + 20
        while True:
            try:
                html = urlopen(base, timeout=1).read().decode()
                break
            except OSError:
                assert time.monotonic() < deadline, 'server readiness timeout'
                time.sleep(0.1)
        class Token(HTMLParser):
            def handle_starttag(self, tag, attrs):
                if tag == 'marimo-server-token':
                    self.value = dict(attrs)['data-token']
        token = Token()
        token.feed(html)
        with connect(f'ws://127.0.0.1:{port}/ws?session_id=logging-test') as ws:
            while True:
                event = json.loads(ws.recv(timeout=15))
                if event.get('op') == 'kernel-ready':
                    break
            headers = {'Marimo-Server-Token': token.value, 'Marimo-Session-Id': 'logging-test', 'Content-Type': 'application/json'}
            body = json.dumps({'objectIds': [], 'values': [], 'autoRun': True}).encode()
            if mode == 'edit':
                with urlopen(Request(base + '/api/kernel/instantiate', data=body, headers=headers), timeout=15) as response:
                    assert json.load(response)['success']
            deadline = time.monotonic() + 15
            while not any(body == 'notebook-record' for body, *_ in received):
                assert time.monotonic() < deadline, received
                time.sleep(0.05)
    finally:
        import signal
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
        try:
            stdout, stderr = process.communicate(timeout=8)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
            raise AssertionError('logging prevented runtime shutdown')
else:
    result = subprocess.run(command, shell=True, env=env, capture_output=True, text=True, timeout=30)
    stdout, stderr = result.stdout, result.stderr
    assert result.returncode == 0, (stdout, stderr)

assert 'private-token' not in stderr, stderr
assert 'ambient-secret' not in stderr, stderr
if mode == 'initialization-failure':
    assert 'initialization_failed' in stderr, stderr
    assert 'workload-completed' in stdout
else:
    assert 'initialization_failed' not in stderr, stderr
if mode == 'python':
    bodies = [body for body, *_ in received]
    assert bodies.count('parent-record') == 1, bodies
    assert bodies.count('spawn-record') == 1, bodies
    assert bodies.count('marimo-debug') == 1, bodies
    assert bodies.count('one-record-per-destination') == 2, bodies
    assert bodies.count('exception-record') == 2, bodies
    parents = [attrs['process.pid'] for body, attrs, *_ in received if body == 'parent-record']
    children = [attrs['process.pid'] for body, attrs, *_ in received if body == 'spawn-record']
    assert parents != children
    assert any(a.key == 'exception.stacktrace' for body, _, _, record in received if body == 'exception-record' for a in record.attributes)
elif mode == 'kernel-exit':
    assert sum(body == 'kernel-final-record' for body, *_ in received) == 1, received
elif mode in ('edit', 'app', 'job'):
    assert sum(body == 'notebook-record' for body, *_ in received) == 1, [(b, a) for b, a, *_ in received]
elif mode == 'failure':
    assert 'workload-completed' in stdout
    assert 'delivery_failed_or_queue_full' in stderr, stderr
    assert len(requests) <= 8, requests
    assert time.monotonic() - started < 8
elif mode == 'overflow':
    assert 'delivery_failed_or_queue_full' in stderr, stderr
elif mode == 'redirect':
    assert requests, 'redirect scenario did not exercise the exporter'
    assert all(path == '/v1/logs' for path, _ in requests), requests
    assert 'delivery_failed_or_queue_full' in stderr, stderr
    assert received == [], received
elif mode == 'disabled':
    assert requests == [], requests

for _, attrs, *_ in received:
    assert attrs['marimohub.notebook_id'] == 'notebook-test', attrs
    assert attrs['service.name'] == 'test-service', attrs
assert all(auth in ('Bearer private-token', None) for _, auth in requests), requests
server.shutdown()
print(json.dumps({'ok': True, 'records': len(received)}))
