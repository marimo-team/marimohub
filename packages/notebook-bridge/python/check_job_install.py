import base64
import json
from pathlib import Path
import subprocess
import sys
import tempfile


payload = json.load(sys.stdin)
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    environment = root / 'environment'
    subprocess.run(['uv', 'venv', '--offline', '--no-config', '--python', '3.12', str(environment)], check=True, capture_output=True)
    python = environment / 'bin' / 'python'
    site = Path(subprocess.check_output(
        [str(python), '-c', 'import sysconfig; print(sysconfig.get_path("purelib"))'],
        text=True,
    ).strip())
    subprocess.run([str(python), '-c', 'import importlib.util; assert importlib.util.find_spec("marimohub") is None'], check=True)
    # A console entrypoint keeps this installation test independent of marimo releases.
    distribution = site / 'marimo-0.0.dist-info'
    distribution.mkdir()
    (distribution / 'METADATA').write_text('Metadata-Version: 2.1\nName: marimo\nVersion: 0.0\n')
    (distribution / 'entry_points.txt').write_text('[console_scripts]\nmarimo = job_export:main\n')
    (site / 'job_export.py').write_text('''
import sys

def main():
    assert sys.argv[1:3] == ['export', 'html']
    from marimohub.jobs import Run
    assert callable(Run.patch_metadata)
    assert callable(Run.acknowledge_stop)
    print('export with Run')
''')
    launcher = root / 'marimo-bridge.py'
    launcher.write_text(payload['launcher'])
    (root / payload['name']).write_bytes(base64.b64decode(payload['wheel']))
    (root / 'install.json').write_text(json.dumps({'identity': payload['identity'], 'wheel': payload['name']}))
    command = [str(python), str(launcher), 'export', 'html', 'app.py']
    subprocess.run(command, check=True)
    (site / 'marimohub' / 'jobs.py').write_text('class Jobs: pass\n')
    (site / 'marimohub_notebook_bridge' / 'identity').write_text('old')
    subprocess.run(command, check=True)
