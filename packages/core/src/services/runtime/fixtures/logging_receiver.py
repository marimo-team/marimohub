import base64
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import ExportLogsServiceRequest
from google.protobuf.json_format import ParseDict


class OtlpReceiver:
    def __init__(self, respond, success_status=200):
        self.requests = []
        self.records = []
        self.request_times = []
        receiver = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                receiver.requests.append((self.path, self.headers.get('Authorization')))
                receiver.request_times.append(time.monotonic())
                data = self.rfile.read(int(self.headers['Content-Length']))
                assert self.headers['Content-Type'] == 'application/json'
                payload = json.loads(data)
                if respond(self):
                    return
                # OTLP uses hex IDs; the standard Protobuf JSON decoder expects base64.
                for resource in payload['resourceLogs']:
                    for scope in resource['scopeLogs']:
                        for record in scope['logRecords']:
                            for key, size in [('traceId', 16), ('spanId', 8)]:
                                if key in record:
                                    value = bytes.fromhex(record[key])
                                    assert len(value) == size
                                    record[key] = base64.b64encode(value).decode()
                decoded = ParseDict(payload, ExportLogsServiceRequest())
                for resource in decoded.resource_logs:
                    attributes = {
                        a.key: getattr(a.value, a.value.WhichOneof('value'))
                        for a in resource.resource.attributes
                    }
                    for scope in resource.scope_logs:
                        for record in scope.log_records:
                            receiver.records.append((record.body.string_value, attributes, record.severity_number, record))
                self.send_response(success_status)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                if success_status != 204:
                    self.wfile.write(b'{}')

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_port}'

    def shutdown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
