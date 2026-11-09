import json
import logging
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


directory = Path(sys.argv[1])
received = []


class Receiver(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        received.append((self.path, payload))
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{}')


server = ThreadingHTTPServer(('127.0.0.1', 0), Receiver)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
base = {
    'name': 'selected', 'level': 'DEBUG', 'headers': {},
    'serviceName': 'selection-test', 'attributes': {},
}
policies = [('selected', ['approved_app']), ('other', ['other']), ('legacy', None)]
invalid = [None, [], 'approved_app', ['root'], [''], ['a..b'], ['a*'], ['a?'],
           ['[a]'], ['a\n'], ['a\x80'], ['a' * 129], ['a'] * 33, [42]]
config = []
for name, names in policies:
    destination = {**base, 'name': name, 'url': f'http://127.0.0.1:{server.server_port}/{name}'}
    if names is not None:
        destination['loggerNames'] = names
    config.append(destination)
for index, names in enumerate(invalid):
    config.append({**base, 'url': f'http://127.0.0.1:{server.server_port}/invalid-{index}',
                   'loggerNames': names})
# A failed destination must not prevent another destination from delivering.
config.append({**config[0], 'name': 'failure', 'url': 'http://127.0.0.1:1/failure'})
(directory / 'logging.json').write_text(json.dumps(config))
program = r'''
import logging
import marimohub_logging as bootstrap
existing_handler = logging.StreamHandler()
existing_formatter = logging.Formatter('%(message)s')
existing_filter = logging.Filter()
existing_handler.setFormatter(existing_formatter)
existing_handler.addFilter(existing_filter)
logging.getLogger().addHandler(existing_handler)
bootstrap.install()
assert existing_handler in logging.getLogger().handlers
assert existing_handler.formatter is existing_formatter
assert existing_handler.filters == [existing_filter]
extra = {'trace.id': 'trace-value', 'trace.parent_id': 'parent-value', 'app_handle': 'app', 'action_id': 'action'}
for name in ['approved_app', 'approved_app.worker', 'approved_application', 'other', 'dependency', 'marimo', 'requests.adapters']:
    logging.getLogger(name).warning(name, extra=extra)
print('print-only')
# Exercise the filter with an extra that cannot be encoded: a rejected record must
# never reach the encoding path, even if logging.raiseExceptions is enabled.
selected = next(handler for handler in logging.getLogger().handlers
                if isinstance(handler, bootstrap.Handler) and handler.names == ('approved_app',))
original = selected.processor.on_emit
def guarded(record):
    assert record.name.startswith('approved_app')
    original(record)
selected.processor.on_emit = guarded
selected.handle(logging.makeLogRecord({'name': 'dependency', 'msg': 'excluded', 'bad': object()}))
bootstrap.shutdown()
'''
try:
    result = subprocess.run([sys.executable, '-c', program], cwd=directory,
                            capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr
    assert 'print-only' in result.stdout
    assert 'record_encoding_failed' not in result.stderr
    assert result.stderr.count('invalid_logger_selection') == len(invalid), result.stderr
    records = {}
    for path, payload in received:
        for resource in payload['resourceLogs']:
            for scope in resource['scopeLogs']:
                for record in scope['logRecords']:
                    records.setdefault(path, []).append(record)
    bodies = lambda path: {record['body']['stringValue'] for record in records[path]}
    assert bodies('/selected') == {'approved_app', 'approved_app.worker'}, records
    assert bodies('/other') == {'other'}, records
    assert bodies('/legacy') == {'approved_app', 'approved_app.worker', 'approved_application', 'other', 'dependency', 'marimo'}, records
    assert set(records) == {'/selected', '/other', '/legacy'}, records
    for record in records['/selected']:
        attrs = {attr['key']: attr['value'] for attr in record['attributes']}
        for key, value in [('trace.id', 'trace-value'), ('trace.parent_id', 'parent-value'), ('app_handle', 'app'), ('action_id', 'action')]:
            assert attrs[key] == {'stringValue': value}, attrs
    print(json.dumps({'ok': True}))
finally:
    server.shutdown()
    server.server_close()
    thread.join()
