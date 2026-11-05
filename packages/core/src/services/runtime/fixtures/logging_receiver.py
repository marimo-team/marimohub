import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import ExportLogsServiceRequest


class OtlpReceiver:
    def __init__(self, respond):
        self.requests = []
        self.records = []
        receiver = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                receiver.requests.append((self.path, self.headers.get('Authorization')))
                data = self.rfile.read(int(self.headers['Content-Length']))
                if respond(self):
                    return
                decoded = ExportLogsServiceRequest.FromString(data)
                for resource in decoded.resource_logs:
                    attributes = {
                        a.key: getattr(a.value, a.value.WhichOneof('value'))
                        for a in resource.resource.attributes
                    }
                    for scope in resource.scope_logs:
                        for record in scope.log_records:
                            receiver.records.append((record.body.string_value, attributes, record.severity_number, record))
                self.send_response(200)
                self.end_headers()

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_port}'

    def shutdown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
