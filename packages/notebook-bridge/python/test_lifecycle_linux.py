import concurrent.futures
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
import uuid

from lifecycle_supervisor import LifecycleError, ProcessTree, Supervisor, exchange, recover_dead_supervisor, supervise


def run_worker():
    if os.environ.get('MARIMOHUB_LIFECYCLE_CHILD') != '1':
        if os.environ.get('TEST_CRASH_AFTER_READY'):
            checkpoint = Supervisor.checkpoint

            def crash(self, *args):
                checkpoint(self, *args)
                os.kill(os.getpid(), signal.SIGKILL)

            Supervisor.checkpoint = crash
        if os.environ.get('TEST_CRASH_AFTER_STOP_RECEIPT'):
            write_receipt = Supervisor.write_receipt

            def crash_after_receipt(self, *args):
                write_receipt(self, *args)
                os.kill(os.getpid(), signal.SIGKILL)

            Supervisor.write_receipt = crash_after_receipt
        raise SystemExit(supervise([__file__, '--worker', *sys.argv[2:]]))
    from lifecycle import install
    install()
    if os.environ.get('TEST_PAUSE_SAVE'):
        from marimo._session.notebook.storage import FilesystemStorage
        write = FilesystemStorage.write

        def paused_write(self, path, content):
            directory = Path(os.environ['MARIMOHUB_LIFECYCLE_DIR'])
            if (directory / 'pause-save').exists():
                (directory / 'save-entered').write_text('ready')
                with (directory / 'save-release').open('rb', buffering=0) as release:
                    release.read(1)
                (directory / 'pause-save').unlink()
            return write(self, path, content)

        FilesystemStorage.write = paused_write
    sys.argv = ['marimo', '--quiet', 'edit', sys.argv[2], '--port', '2718', '--host', '127.0.0.1', '--headless', '--no-token', '--no-skew-protection', '--skip-update-check']
    entry = next(item for item in importlib.metadata.distribution('marimo').entry_points if item.group == 'console_scripts' and item.name == 'marimo')
    entry.load()()


def wait_until(check, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            value = check()
            if value:
                return value
        except (OSError, ValueError):
            pass
        time.sleep(0.01)
    raise TimeoutError('Runtime did not reach the requested state')


@unittest.skipUnless(sys.platform == 'linux' and importlib.util.find_spec('marimo'), 'requires Linux and installed marimo')
class LinuxRuntimeTests(unittest.TestCase):
    def start(self, crash=False, pause_save=False, restore=None, crash_stop=False):
        from websockets.sync.client import connect
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        source = root / 'notebook.py'
        source.write_text('import marimo\napp = marimo.App()\n\n@app.cell\ndef _():\n    value = 42\n    value\n    return (value,)\n')
        if restore:
            for name, content in restore.items():
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
        directory = root / ('sandbox-' + 'x' * 100) / 'lifecycle' / 'captures' / str(uuid.uuid4())
        log = (root / 'server.log').open('w+')
        self.addCleanup(log.close)
        process = subprocess.Popen([sys.executable, __file__, '--worker', str(source)], cwd=root, env={**os.environ, 'MARIMOHUB_LIFECYCLE_DIR': str(directory), **({'TEST_CRASH_AFTER_READY': '1'} if crash else {}), **({'TEST_PAUSE_SAVE': '1'} if pause_save else {}), **({'TEST_CRASH_AFTER_STOP_RECEIPT': '1'} if crash_stop else {})}, start_new_session=True, stdout=log, stderr=log)

        def cleanup():
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=10)

        self.addCleanup(cleanup)
        try:
            def started():
                if process.poll() is not None:
                    raise RuntimeError(f'Runtime exited during startup with code {process.returncode}')
                return (directory / 'native.sock').exists()

            wait_until(started)
            wait_until(lambda: urllib.request.urlopen('http://127.0.0.1:2718/health', timeout=1).status == 200)
            self.session_id = str(uuid.uuid4())
            ws = connect(f'ws://127.0.0.1:2718/ws?session_id={self.session_id}', open_timeout=10, legacy=True)
            self.addCleanup(ws.close)
            self.ready = json.loads(ws.recv(timeout=10))
        except BaseException:
            log.seek(0)
            print(log.read(), file=sys.stderr)
            raise
        return root, source, directory, process, ws

    def post(self, path, body):
        request = urllib.request.Request('http://127.0.0.1:2718/api/kernel/' + path, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json', 'Marimo-Session-Id': self.session_id})
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.read()

    def prepare(self, directory, source):
        status = exchange(directory / 'control.sock', {'action': 'status'})
        return exchange(directory / 'control.sock', {'action': 'prepare', 'generation': status['generation'], 'token': str(uuid.uuid4()), 'entry': source.name, 'workdir': str(source.parent)}, timeout=40)

    def execute(self, ws, codes=None, value=42):
        if codes is None:
            self.post('instantiate', {'objectIds': [], 'values': [], 'autoRun': True})
        else:
            self.post('run', {'cellIds': self.ready['data']['cell_ids'], 'codes': codes})
        output_seen = False
        while True:
            message = json.loads(ws.recv(timeout=10))
            if message.get('op') != 'cell-op':
                continue
            output = message['data'].get('output') or {}
            if output.get('mimetype') == 'text/html' and output.get('data') == f"<pre class='text-xs'>{value}</pre>":
                output_seen = True
            if output_seen and message['data'].get('status') == 'idle':
                return

    def snapshot(self, checkpoint, source):
        root = Path(checkpoint['checkpoint'])
        return {name: (root / name).read_bytes() for name in (source.name, '__marimo__/session/notebook.py.json')}

    def assert_output(self, snapshot, value):
        native = json.loads(snapshot['__marimo__/session/notebook.py.json'])
        self.assertEqual(native['cells'][0]['outputs'][0]['data']['text/html'], f"<pre class='text-xs'>{value}</pre>")

    def kill_runtime(self, process, ws):
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=10)
        ws.close()

    def test_runtime_death_restores_only_published_source_and_outputs(self):
        for publish_latest in (False, True):
            with self.subTest(publish_latest=publish_latest):
                root, source, directory, process, ws = self.start()
                self.execute(ws)
                checkpoint = self.prepare(directory, source)
                durable = self.snapshot(checkpoint, source)
                self.assert_output(durable, 42)
                exchange(directory / 'control.sock', {'action': 'abort', 'token': checkpoint['token']})
                ready = self.ready['data']
                codes = [code.replace('42', '84') for code in ready['codes']]
                self.post('save', {'cellIds': ready['cell_ids'], 'codes': codes, 'names': ready['names'], 'configs': ready['configs'], 'filename': str(source)})
                self.execute(ws, codes, 84)
                latest = self.prepare(directory, source)
                latest_snapshot = self.snapshot(latest, source)
                self.assert_output(latest_snapshot, 84)
                self.assertNotEqual(durable[source.name], latest_snapshot[source.name])
                if publish_latest:
                    durable = latest_snapshot
                # The retained copy represents already published bytes; runtime-local
                # captures and acknowledged but unpublished saves die with this process.
                self.kill_runtime(process, ws)
                root2, source2, directory2, process2, ws2 = self.start(restore=durable)
                restored = self.prepare(directory2, source2)
                snapshot = self.snapshot(restored, source2)
                self.assertEqual(snapshot[source2.name], durable[source.name])
                self.assert_output(snapshot, 84 if publish_latest else 42)
                self.kill_runtime(process2, ws2)

    def test_stop_receipt_survives_supervisor_death_before_writer_destruction(self):
        root, source, directory, process, ws = self.start(crash_stop=True)
        self.execute(ws)
        checkpoint = self.prepare(directory, source)
        durable = self.snapshot(checkpoint, source)
        with self.assertRaises((ValueError, OSError)):
            exchange(directory / 'control.sock', {'action': 'commit-stop', 'token': checkpoint['token']})
        process.wait(timeout=10)
        receipt = json.loads((directory / 'stop.json').read_text())
        table = ProcessTree(process.pid).table()
        self.assertTrue(any(table.get(int(pid), (None, None, None))[2] in ('T', 't') for pid in receipt['processes']))
        for _ in range(2):
            self.assertEqual(recover_dead_supervisor(directory), {'ok': True, 'state': 'stopped', 'token': checkpoint['token']})
        wait_until(lambda: all(ProcessTree(process.pid).table().get(int(pid), (None, None, 'Z'))[2] == 'Z' for pid in receipt['processes']))
        ws.close()
        root2, source2, directory2, process2, ws2 = self.start(restore=durable)
        restored = self.prepare(directory2, source2)
        self.assert_output(self.snapshot(restored, source2), 42)
        self.kill_runtime(process2, ws2)

    def test_live_native_snapshot_resume_and_committed_stop(self):
        root, source, directory, process, ws = self.start()
        checkpoint = self.prepare(directory, source)
        captured = Path(checkpoint['checkpoint'])
        self.assertEqual((captured / source.name).read_bytes(), source.read_bytes())
        native = json.loads((captured / '__marimo__/session/notebook.py.json').read_text())
        self.assertIn('cells', native)
        journal = json.loads((directory / 'attempt.json').read_text())
        table = ProcessTree(process.pid).table()
        self.assertGreaterEqual(len(journal['processes']), 2)
        for pid in journal['processes']:
            self.assertIn(table[int(pid)][2], ('T', 't', 'Z'))
        exchange(directory / 'control.sock', {'action': 'abort', 'token': checkpoint['token']})
        self.assertFalse(captured.exists())
        ws.ping().wait(timeout=5)
        self.assertEqual(urllib.request.urlopen('http://127.0.0.1:2718/health', timeout=2).status, 200)
        checkpoint = self.prepare(directory, source)
        self.assertEqual(exchange(directory / 'control.sock', {'action': 'commit-stop', 'token': checkpoint['token']})['state'], 'stopped')
        self.assertEqual(exchange(directory / 'control.sock', {'action': 'commit-stop', 'token': checkpoint['token']})['state'], 'stopped')
        with self.assertRaisesRegex(LifecycleError, 'CAPTURE_ALREADY_STOPPED'):
            exchange(directory / 'control.sock', {'action': 'abort', 'token': checkpoint['token']})

    def test_native_save_drains_before_capture_and_outputs_restore(self):
        root, source, directory, process, ws = self.start(pause_save=True)
        self.execute(ws)
        initial = source.read_bytes()
        ready = self.ready['data']
        body = {'cellIds': ready['cell_ids'], 'codes': ready['codes'], 'names': ready['names'], 'configs': ready['configs'], 'filename': str(source)}
        (directory / 'pause-save').write_text('pause')
        os.mkfifo(directory / 'save-release')
        with concurrent.futures.ThreadPoolExecutor(2) as tasks:
            saving = tasks.submit(self.post, 'save', body)
            wait_until(lambda: (directory / 'save-entered').exists())
            capturing = tasks.submit(self.prepare, directory, source)
            wait_until(lambda: (directory / 'attempt.json').exists() and json.loads((directory / 'attempt.json').read_text()).get('state') == 'preparing')
            self.assertFalse(saving.done())
            self.assertFalse(capturing.done())
            with (directory / 'save-release').open('wb', buffering=0) as release:
                release.write(b'1')
            acknowledged = saving.result(timeout=30)
            checkpoint = capturing.result(timeout=40)
        captured = Path(checkpoint['checkpoint'])
        self.assertNotEqual(initial, acknowledged)
        self.assertEqual((captured / source.name).read_bytes(), acknowledged)
        native_path = '__marimo__/session/notebook.py.json'
        native = json.loads((captured / native_path).read_text())
        self.assertEqual(native['cells'][0]['outputs'][0]['data']['text/html'], "<pre class='text-xs'>42</pre>")
        restored = {source.name: acknowledged, native_path: (captured / native_path).read_bytes()}
        exchange(directory / 'control.sock', {'action': 'commit-stop', 'token': checkpoint['token']})
        ws.close()
        root2, source2, directory2, process2, ws2 = self.start(restore=restored)
        checkpoint2 = self.prepare(directory2, source2)
        restored_native = json.loads((Path(checkpoint2['checkpoint']) / native_path).read_text())
        self.assertEqual(restored_native['cells'][0]['outputs'][0]['data']['text/html'], "<pre class='text-xs'>42</pre>")
        exchange(directory2 / 'control.sock', {'action': 'abort', 'token': checkpoint2['token']})

    def test_recovers_supervisor_death_after_ready_before_final_journal(self):
        root, source, directory, process, ws = self.start(crash=True)
        with self.assertRaises((ValueError, OSError)):
            self.prepare(directory, source)
        process.wait(timeout=10)
        saved = json.loads((directory / 'attempt.json').read_text())
        self.assertEqual(saved['state'], 'preparing')
        worker = saved['worker']
        self.assertIn(str(worker), saved['processes'])
        self.assertIn(ProcessTree(process.pid).table()[worker][2], ('T', 't'))
        self.assertEqual(recover_dead_supervisor(directory)['state'], 'running')
        self.assertEqual(urllib.request.urlopen('http://127.0.0.1:2718/health', timeout=2).status, 200)
        self.assertFalse((directory / 'captures' / saved['token']).exists())
        self.assertFalse(json.loads((directory / 'capability.json').read_text())['supported'])


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--worker':
        run_worker()
    else:
        unittest.main()
