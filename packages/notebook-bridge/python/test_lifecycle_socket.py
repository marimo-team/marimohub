import asyncio
import os
from pathlib import Path
import socket
import sys
import tempfile
import unittest

from lifecycle import CaptureGate, DrainMiddleware, install_status_only
from lifecycle_socket import socket_path
from lifecycle_supervisor import exchange


@unittest.skipUnless(sys.platform == 'linux', 'requires Linux procfs')
class LongSocketPathTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.directory = Path(temp.name) / ('sandbox-' * 20) / 'lifecycle'
        self.directory.mkdir(parents=True)

    def test_status_server_and_client_keep_socket_private_at_long_path(self):
        path = self.directory / 'native.sock'
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            with self.assertRaises(OSError):
                connection.bind(str(path))
        server = install_status_only(self.directory)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.assertEqual(exchange(path, {'action': 'status'}), {'ok': True, 'state': 'running'})
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_async_native_socket(self):
        async def run():
            gate = CaptureGate()

            async def app(scope, receive, send):
                reply = await asyncio.to_thread(exchange, self.directory / 'native.sock', {'action': 'status'})
                self.assertTrue(reply['ok'])

            from unittest.mock import patch
            with patch.dict(os.environ, MARIMOHUB_LIFECYCLE_DIR=str(self.directory)):
                await DrainMiddleware(app, gate)({'type': 'lifespan'}, None, None)

        asyncio.run(run())

    def test_descriptor_closes_after_failure_without_changing_cwd(self):
        cwd = os.getcwd()
        with self.assertRaisesRegex(RuntimeError, 'failure'):
            with socket_path(self.directory / 'control.sock') as address:
                descriptor = int(address.split('/')[-2])
                os.fstat(descriptor)
                raise RuntimeError('failure')
        with self.assertRaises(OSError):
            os.fstat(descriptor)
        self.assertEqual(os.getcwd(), cwd)
