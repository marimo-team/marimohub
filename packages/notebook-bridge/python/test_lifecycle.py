import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch
import uuid

from lifecycle import CaptureGate, CaptureUnsupported, DrainMiddleware, read_file, write_file
from lifecycle_supervisor import LifecycleError, Supervisor


class FakeTree:
    def __init__(self):
        self.resumed = []
        self.stopped = []
        self.fail = False

    def identity(self, pid):
        return 'server-generation'

    def freeze(self, frozen, excluded=(), before_signal=lambda: None, deadline=None):
        frozen[20] = 'kernel-generation'
        before_signal()
        if self.fail:
            raise LifecycleError('CAPTURE_DRAIN_TIMEOUT')
        if 10 not in excluded:
            frozen[10] = 'server-generation'

    def resume(self, frozen):
        self.resumed.append(dict(frozen))

    def stop(self, frozen):
        self.stopped.append(dict(frozen))


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.tree = FakeTree()
        self.now = 0
        self.supervisor = Supervisor(self.temp.name, 10, self.tree, clock=lambda: self.now)
        self.supervisor.native = lambda *args, **kwargs: {'ok': True}
        self.supervisor.checkpoint = lambda *args: {'ok': True}
        self.token = str(uuid.uuid4())

    def prepare(self):
        return self.supervisor.handle({'action': 'prepare', 'token': self.token, 'generation': self.supervisor.generation, 'entry': 'n.py', 'workdir': '/workspace'})

    def operation(self, action):
        return self.supervisor.handle({'action': action, 'token': self.token})

    def test_expiry_resumes_and_rejects_delayed_commit(self):
        self.assertEqual(self.prepare()['state'], 'paused')
        self.now = 61
        self.supervisor.expire()
        with self.assertRaisesRegex(LifecycleError, 'CAPTURE_EXPIRED'):
            self.operation('commit-stop')
        self.assertEqual(len(self.tree.resumed), 1)
        self.assertFalse(self.tree.stopped)

    def test_commit_receipt_prevents_watchdog_and_explicit_resume(self):
        self.prepare()
        self.assertEqual(self.operation('commit-stop')['state'], 'stopped')
        self.now = 61
        self.supervisor.expire()
        with self.assertRaisesRegex(LifecycleError, 'CAPTURE_ALREADY_STOPPED'):
            self.operation('abort')
        self.assertFalse(self.tree.resumed)
        self.assertTrue(self.tree.stopped)
        self.assertEqual(self.operation('commit-stop')['state'], 'stopped')

    def test_partial_freeze_failure_resumes_every_stopped_process(self):
        self.tree.fail = True
        with self.assertRaisesRegex(LifecycleError, 'CAPTURE_DRAIN_TIMEOUT'):
            self.prepare()
        self.assertEqual(self.tree.resumed, [{10: 'server-generation', 20: 'kernel-generation'}])
        self.assertIsNone(self.supervisor.attempt)

    def test_journal_failure_resumes_and_fences_retry_after_disk_recovers(self):
        for fail_after in (0, 1, 3):
            with self.subTest(fail_after=fail_after):
                original = self.supervisor.write_record
                calls = 0
                generation = self.supervisor.generation
                token = str(uuid.uuid4())
                self.token = token

                def failing_write(*args):
                    nonlocal calls
                    calls += 1
                    if calls > fail_after:
                        raise OSError('disk unavailable')
                    return original(*args)

                with patch.object(self.supervisor, 'write_record', failing_write):
                    with self.assertRaises(OSError):
                        self.prepare()
                self.assertIsNone(self.supervisor.attempt)
                self.assertTrue(self.tree.resumed)
                with self.assertRaisesRegex(LifecycleError, 'CAPTURE_EXPIRED'):
                    self.supervisor.handle({'action': 'prepare', 'token': token, 'generation': generation})
                self.token = str(uuid.uuid4())
                self.assertEqual(self.prepare()['state'], 'paused')
                self.operation('abort')

    def test_abort_journal_failure_does_not_leave_a_busy_runtime(self):
        self.prepare()
        with patch.object(self.supervisor, 'write_record', side_effect=OSError('disk unavailable')):
            with self.assertRaises(OSError):
                self.operation('abort')
        self.assertIsNone(self.supervisor.attempt)
        self.token = str(uuid.uuid4())
        self.assertEqual(self.prepare()['state'], 'paused')
        self.operation('abort')

    def test_restart_after_lost_commit_ack_never_resumes(self):
        self.prepare()
        original = self.supervisor.write_receipt

        def lost_ack(receipt):
            original(receipt)
            raise OSError('ack lost')

        self.supervisor.write_receipt = lost_ack
        with self.assertRaises(OSError):
            self.operation('commit-stop')
        self.now = 61
        with self.assertRaisesRegex(LifecycleError, 'CAPTURE_ALREADY_STOPPED'):
            self.supervisor.expire()
        recovered = Supervisor(self.temp.name, 10, self.tree)
        self.assertEqual(recovered.handle({'action': 'commit-stop', 'token': self.token})['state'], 'stopped')
        self.assertFalse(self.tree.resumed)

    def test_concurrent_prepare_cannot_replace_active_token(self):
        self.prepare()
        with self.assertRaisesRegex(LifecycleError, 'CAPTURE_BUSY'):
            self.supervisor.handle({'action': 'prepare', 'token': str(uuid.uuid4())})
        self.assertEqual(self.supervisor.attempt['token'], self.token)

    def test_expired_prepare_cannot_recreate_token_after_checkpoint_cleanup(self):
        result = self.prepare()
        self.operation('abort')
        self.assertFalse(Path(result['checkpoint']).exists())
        with self.assertRaisesRegex(LifecycleError, 'CAPTURE_EXPIRED'):
            self.supervisor.handle({'action': 'prepare', 'token': self.token, 'generation': 0})


class GateTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.gate = CaptureGate()
        self.gate.app = types.SimpleNamespace(state=types.SimpleNamespace(session_manager=types.SimpleNamespace(sessions={})))

    async def test_drains_admitted_http_and_rejects_new_mutations(self):
        entered = asyncio.Event()
        finish = asyncio.Event()
        replies = []

        async def app(scope, receive, send):
            entered.set()
            await finish.wait()

        async def send(message):
            replies.append(message)

        middleware = DrainMiddleware(app, self.gate)
        scope = {'type': 'http', 'method': 'POST'}
        request = asyncio.create_task(middleware(scope, None, send))
        await entered.wait()
        draining = asyncio.create_task(self.gate.drain())
        await asyncio.sleep(0)
        self.assertFalse(draining.done())
        await middleware(scope, None, send)
        self.assertEqual(replies[0]['status'], 503)
        finish.set()
        await request
        await draining
        self.assertTrue(self.gate.notifications_closed)
        self.gate.resume()
        self.assertFalse(self.gate.closed)

    async def test_checkpoint_resume_preserves_live_websocket_and_gates_frames(self):
        waiting = asyncio.Event()
        processed = asyncio.Event()
        incoming = asyncio.Queue()
        outgoing = []

        async def receive():
            waiting.set()
            return await incoming.get()

        async def send(message):
            outgoing.append(message)

        async def app(scope, receive, send):
            await send({'type': 'websocket.accept'})
            await receive()
            processed.set()

        connection = asyncio.create_task(DrainMiddleware(app, self.gate)({'type': 'websocket'}, receive, send))
        try:
            await waiting.wait()
            await self.gate.drain()
            incoming.put_nowait({'type': 'websocket.receive', 'text': 'edit'})
            await asyncio.sleep(0)
            self.assertFalse(processed.is_set())
            self.assertEqual(outgoing, [{'type': 'websocket.accept'}])
            self.gate.resume()
            await connection
            self.assertTrue(processed.is_set())
        finally:
            connection.cancel()
            await asyncio.gather(connection, return_exceptions=True)

    async def test_notifications_are_replayed_once_after_resume(self):
        values = []
        await self.gate.drain()
        self.gate.notification(values.append, b'one')
        self.gate.notification(values.append, b'two')
        self.assertEqual(values, [])
        self.gate.resume()
        self.assertEqual(values, [b'one', b'two'])

    async def test_autosave_failure_is_not_mistaken_for_a_successful_drain(self):
        self.gate.autosave_failed = True
        with self.assertRaisesRegex(CaptureUnsupported, 'CAPTURE_NATIVE_SAVE_FAILED'):
            await self.gate.drain()
        self.gate.resume()
        self.assertFalse(self.gate.closed)


class FileTests(unittest.TestCase):
    def test_non_regular_files_reject_without_waiting_for_a_fifo_writer(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            os.mkfifo(root / 'fifo')
            (root / 'directory').mkdir()
            script = """
from pathlib import Path
import sys
from lifecycle import read_file, CaptureUnsupported
try:
    read_file(Path(sys.argv[1]), Path(sys.argv[2]))
except CaptureUnsupported as error:
    assert str(error) == 'CAPTURE_INVALID_PATH', str(error)
else:
    raise AssertionError('Non-regular file accepted')
"""
            for name in ('fifo', 'directory'):
                with self.subTest(name=name):
                    result = subprocess.run(
                        [sys.executable, '-c', script, temp, name],
                        cwd=Path(__file__).parent, capture_output=True, text=True, timeout=3,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)

    def test_bounded_reads_reject_symlinks_and_oversized_files(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'source.py').write_text('12345')
            (root / 'link.py').symlink_to(root / 'source.py')
            with self.assertRaises(OSError):
                read_file(root, Path('link.py'))
            with patch('lifecycle.MAX_ARTIFACT_BYTES', 4):
                with self.assertRaisesRegex(CaptureUnsupported, 'ARTIFACT_TOO_LARGE'):
                    read_file(root, Path('source.py'))
                with self.assertRaisesRegex(CaptureUnsupported, 'ARTIFACT_TOO_LARGE'):
                    write_file(root / 'snapshot.json', ['123', '45'])


if __name__ == '__main__':
    unittest.main()
