import json
import os
from pathlib import Path
import subprocess
import sys

from logging_receiver import OtlpReceiver

directory, mode, command = sys.argv[1:]
server = OtlpReceiver(lambda request: False)
config_path = Path(directory, 'logging.json')
config = json.loads(config_path.read_text())
config[0]['url'] = server.url + '/v1/logs'
config_path.write_text(json.dumps(config))
custom = Path('custom')
custom.mkdir()
(custom / 'sitecustomize.py').write_text('''
import builtins, subprocess, sys
class BlockOtel:
    def find_spec(self, fullname, path=None, target=None):
        if fullname.startswith('opentelemetry'):
            raise RuntimeError('bootstrap imported OpenTelemetry')
builtins.otel_guard = BlockOtel()
sys.meta_path.insert(0, builtins.otel_guard)
def no_process(*args, **kwargs):
    raise RuntimeError('bootstrap spawned a process')
subprocess.Popen = no_process
''')
env = {**os.environ, 'PYTHONPATH': str(custom.resolve()), 'UV_OFFLINE': '1', 'MARIMOHUB_TEST_MODE': mode}
Path('workload.py').write_text('''
import builtins, json, logging, os, sys
from importlib.metadata import PackageNotFoundError, version
import marimohub_logging as bootstrap
assert len(bootstrap._processors) == 1
sys.meta_path.remove(builtins.otel_guard)
expected = os.environ['MARIMOHUB_TEST_OTEL_VERSION']
for name in ['opentelemetry-api', 'opentelemetry-sdk', 'opentelemetry-exporter-otlp-proto-http']:
    try:
        actual = version(name)
    except PackageNotFoundError:
        actual = 'absent'
    assert actual == expected, (name, actual, expected)
if expected == '1.20.0':
    from opentelemetry.exporter.otlp.proto.grpc._log_exporter import OTLPLogExporter
if expected == 'absent':
    assert not any(name.startswith('opentelemetry') for name in sys.modules)
trace_context = None
if expected != 'absent':
    from opentelemetry import trace
    from opentelemetry.sdk.trace import TracerProvider
    trace.set_tracer_provider(TracerProvider())
    with trace.get_tracer('notebook').start_as_current_span('example') as span:
        context = span.get_span_context()
        trace_context = [context.trace_id, context.span_id]
        logging.info('traced-record')
mode = os.environ['MARIMOHUB_TEST_MODE']
if mode == 'typed-values':
    logging.info('typed-record', extra={
        'minimum': -(2 ** 63), 'maximum': 2 ** 63 - 1, 'large': 2 ** 64,
        'flag': True, 'fraction': 1.25, 'null': None, 'bytes': b'\\x00\\xff',
        'nested': {'items': [1, 'two', False]}, 'nonfinite': float('nan'),
    })
elif mode == 'oversized-record':
    logging.info('x' * (65 * 1024))
elif mode == 'cyclic-extras':
    cycle = {}
    cycle['self'] = cycle
    logging.info('cycle', extra={'cycle': cycle})
try:
    raise ValueError('example-error')
except ValueError:
    logging.exception('exception-record')
logging.info('normal-record', extra={'rows': 12, 'label': '日本語'})
bootstrap.shutdown()
print(json.dumps({'pid': os.getpid(), 'trace_context': trace_context}))
''')
try:
    result = subprocess.run(command, shell=True, env=env, capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, (result.stdout, result.stderr)
    assert 'initialization_failed' not in result.stderr, result.stderr
    assert 'delivery_failed' not in result.stderr, result.stderr
    completed = json.loads(result.stdout)
    records = {body: record for body, _, _, record in server.records}
    assert 'normal-record' in records, (records, result.stderr)
    assert all(attrs['process.pid'] == completed['pid'] for _, attrs, *_ in server.records)
    normal = records['normal-record']
    assert normal.time_unix_nano > 0 and normal.observed_time_unix_nano >= normal.time_unix_nano
    assert normal.severity_number == 9 and normal.severity_text == 'INFO'
    attributes = {a.key: a.value for a in normal.attributes}
    assert attributes['rows'].int_value == 12
    assert attributes['label'].string_value == '日本語'
    exception = {a.key: a.value.string_value for a in records['exception-record'].attributes}
    assert exception['exception.type'] == 'ValueError'
    assert 'example-error' in exception['exception.stacktrace']
    if completed['trace_context']:
        traced = records['traced-record']
        assert [int.from_bytes(traced.trace_id), int.from_bytes(traced.span_id)] == completed['trace_context']
    if mode == 'typed-values':
        attrs = {a.key: a.value for a in records['typed-record'].attributes}
        assert attrs['minimum'].int_value == -(2 ** 63)
        assert attrs['maximum'].int_value == 2 ** 63 - 1
        assert attrs['large'].string_value == str(2 ** 64)
        assert attrs['flag'].bool_value is True
        assert attrs['fraction'].double_value == 1.25
        assert attrs['null'].WhichOneof('value') is None
        assert attrs['bytes'].bytes_value == b'\x00\xff'
        assert attrs['nested'].kvlist_value.values[0].value.array_value.values[2].bool_value is False
        assert attrs['nonfinite'].string_value == 'nan'
    if mode in ('oversized-record', 'cyclic-extras'):
        assert 'record_encoding_failed' in result.stderr, result.stderr
        assert len(records) == 2, records
finally:
    server.shutdown()
print(json.dumps({'ok': True, 'records': len(server.records)}))
