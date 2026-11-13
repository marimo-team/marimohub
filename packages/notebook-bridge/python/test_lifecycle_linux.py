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
    def start(self, crash=False, pause_save=False, restore=None):
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
        directory = root / 'lifecycle'
        log = (root / 'server.log').open('w+')
        self.addCleanup(log.close)
        process = subprocess.Popen([sys.executable, __file__, '--worker', str(source)], cwd=root, env={**os.environ, 'MARIMOHUB_LIFECYCLE_DIR': str(directory), **({'TEST_CRASH_AFTER_READY': '1'} if crash else {}), **({'TEST_PAUSE_SAVE': '1'} if pause_save else {})}, start_new_session=True, stdout=log, stderr=log)

        def cleanup():
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=10)

        self.addCleanup(cleanup)
        try:
            wait_until(lambda: (directory / 'native.sock').exists())
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
        self.post('instantiate', {'objectIds': [], 'values': [], 'autoRun': True})
        while True:
            message = json.loads(ws.recv(timeout=10))
            if message.get('op') == 'cell-op' and message['data'].get('status') == 'idle':
                break
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
