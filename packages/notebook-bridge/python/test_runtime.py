import contextlib
import importlib.util
import io
import fcntl
import subprocess
import time
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


extension = load('extension')
launcher = load('launcher')


class ExtensionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        patches = contextlib.ExitStack()
        self.addCleanup(patches.close)
        patches.enter_context(patch.dict(os.environ, {'MARIMOHUB_BRIDGE_PARENT_ORIGIN': 'https://hub.example'}))
        self.files = patches.enter_context(patch.object(extension.importlib.resources, 'files'))
        self.files.return_value.joinpath.return_value.read_text.return_value = '</script>'
        self.app = types.SimpleNamespace(state=types.SimpleNamespace(html_head='existing'))

    def test_discovery_does_not_import_marimo(self):
        self.assertNotIn('marimo', sys.modules)

    async def test_inert_without_configuration(self):
        with patch.dict(os.environ, {}, clear=True):
            async with extension.lifespan(self.app):
                self.assertEqual(self.app.state.html_head, 'existing')
        self.files.assert_not_called()

    async def test_preserves_content_and_injects_once(self):
        async with extension.lifespan(self.app):
            injected = self.app.state.html_head
            self.assertTrue(injected.startswith('existing'))
            self.assertIn('<\\/script>', injected)
            async with extension.lifespan(self.app):
                self.assertEqual(self.app.state.html_head, injected)
        self.assertEqual(self.app.state.html_head, 'existing')
        self.files.assert_called_once()

    async def test_unsupported_state_is_nonfatal(self):
        self.app.state.html_head = []
        with self.assertLogs('extension') as logs:
            async with extension.lifespan(self.app):
                self.assertEqual(self.app.state.html_head, [])
        self.assertEqual(len(logs.output), 1)
        self.assertNotIn('https', logs.output[0])

    async def test_invalid_origins_do_not_load_the_script(self):
        for origin in ['*', 'null', 'file:///tmp/notebook', 'https://user:password@hub.example', 'https://hub.example/path', 'https://hub.example?secret=value']:
            with self.subTest(origin=origin), patch.dict(os.environ, {'MARIMOHUB_BRIDGE_PARENT_ORIGIN': origin}):
                async with extension.lifespan(self.app):
                    self.assertEqual(self.app.state.html_head, 'existing')
        self.files.assert_not_called()

    async def test_missing_script_is_nonfatal_and_diagnostic_omits_details(self):
        self.files.side_effect = OSError('secret-value')
        with self.assertLogs('extension') as logs:
            async with extension.lifespan(self.app):
                self.assertEqual(self.app.state.html_head, 'existing')
        self.assertEqual(len(logs.output), 1)
        self.assertNotIn('secret-value', logs.output[0])
        self.assertNotIn('hub.example', logs.output[0])

    async def test_shutdown_preserves_another_extensions_head_changes(self):
        self.app.state.html_head = None
        async with extension.lifespan(self.app):
            self.app.state.html_head += '<meta name="later">'
            changed = self.app.state.html_head
        self.assertEqual(self.app.state.html_head, changed)

    async def test_shutdown_does_not_mask_application_errors_when_state_disappears(self):
        with self.assertRaisesRegex(RuntimeError, 'application failed'):
            async with extension.lifespan(self.app):
                del self.app.state
                raise RuntimeError('application failed')


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        (root / 'install.json').write_text(json.dumps({'identity': 'new', 'wheel': 'bridge.whl'}))
        patches = contextlib.ExitStack()
        self.addCleanup(patches.close)
        patches.enter_context(patch.object(launcher, '__file__', str(root / 'launcher.py')))
        patches.enter_context(patch.object(sys, 'prefix', str(root)))
        self.cli = unittest.mock.Mock()
        entry = types.SimpleNamespace(group='console_scripts', name='marimo', load=lambda: self.cli)
        distribution = types.SimpleNamespace(entry_points=[entry])
        patches.enter_context(patch.object(launcher.importlib.metadata, 'distribution', return_value=distribution))

    def assert_cli_fallback(self):
        self.cli.reset_mock()
        with patch.dict(os.environ, {'MARIMOHUB_BRIDGE_PARENT_ORIGIN': 'https://private.example'}), contextlib.redirect_stderr(io.StringIO()) as output:
            launcher.main()
            self.assertNotIn('MARIMOHUB_BRIDGE_PARENT_ORIGIN', os.environ)
        self.cli.assert_called_once_with()
        self.assertEqual(json.loads(output.getvalue()), {'event': 'notebook_bridge_unavailable', 'reason': 'install_failed'})

    def test_offline_install_targets_actual_interpreter(self):
        with patch.object(launcher.importlib.resources, 'files', side_effect=ModuleNotFoundError), patch.object(launcher.subprocess, 'run') as run, patch.object(sys, 'executable', '/custom/python'):
            launcher.install()
        args = run.call_args.args[0]
        self.assertEqual(args[:5], ['uv', 'pip', 'install', '--python', '/custom/python'])
        self.assertIn('--no-deps', args)
        self.assertIn('--no-index', args)
        self.assertLessEqual(run.call_args.kwargs['timeout'], 10)

    def test_matching_artifact_skips_install_and_changed_artifact_reinstalls(self):
        identity = types.SimpleNamespace(joinpath=lambda _: types.SimpleNamespace(read_text=lambda: 'new'))
        with patch.object(launcher.importlib.resources, 'files', return_value=identity), patch.object(launcher.subprocess, 'run') as run:
            launcher.install()
            run.assert_not_called()
        old = types.SimpleNamespace(joinpath=lambda _: types.SimpleNamespace(read_text=lambda: 'old'))
        with patch.object(launcher.importlib.resources, 'files', return_value=old), patch.object(launcher.subprocess, 'run') as run:
            launcher.install()
            run.assert_called_once()

    def test_expired_deadline_does_not_install(self):
        with patch.dict(os.environ, {'MARIMOHUB_BRIDGE_STARTUP_DEADLINE_MS': '1'}), patch.object(launcher.subprocess, 'run') as run:
            with self.assertRaises(TimeoutError):
                launcher.install()
            run.assert_not_called()

    def test_failure_disables_extension_and_starts_original_cli(self):
        with patch.object(launcher, 'install', side_effect=RuntimeError('sensitive detail')):
            self.assert_cli_fallback()

    def test_lock_contention_expires_without_installing(self):
        with (Path(sys.prefix) / '.marimohub-notebook-bridge.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            started = time.monotonic()
            with patch.dict(os.environ, {'MARIMOHUB_BRIDGE_INSTALL_TIMEOUT_MS': '20'}), patch.object(launcher.subprocess, 'run') as run:
                with self.assertRaises(TimeoutError):
                    launcher.install()
                run.assert_not_called()
            self.assertLess(time.monotonic() - started, 1)

    def test_failed_install_releases_the_environment_lock(self):
        with patch.object(launcher.importlib.resources, 'files', side_effect=ModuleNotFoundError), patch.object(launcher.subprocess, 'run', side_effect=subprocess.TimeoutExpired('uv', 0.01)):
            with self.assertRaises(subprocess.TimeoutExpired):
                launcher.install()
        with (Path(sys.prefix) / '.marimohub-notebook-bridge.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_remaining_startup_budget_caps_the_install_process_timeout(self):
        with patch.dict(os.environ, {'MARIMOHUB_BRIDGE_STARTUP_DEADLINE_MS': '100250', 'MARIMOHUB_BRIDGE_INSTALL_TIMEOUT_MS': '10000'}), patch.object(launcher.time, 'time', return_value=100), patch.object(launcher.importlib.resources, 'files', side_effect=ModuleNotFoundError), patch.object(launcher.subprocess, 'run') as run:
            launcher.install()
        self.assertGreater(run.call_args.kwargs['timeout'], 0)
        self.assertLessEqual(run.call_args.kwargs['timeout'], 0.25)

    def test_corrupt_configuration_keeps_the_original_cli_usable(self):
        for contents in ['not json', '{}', '{"identity":"new"}']:
            with self.subTest(contents=contents):
                (Path(self.temp.name) / 'install.json').write_text(contents)
                with patch.object(launcher.importlib.resources, 'files', side_effect=ModuleNotFoundError):
                    self.assert_cli_fallback()


if __name__ == '__main__':
    unittest.main()
