import json
from pathlib import Path
import sys

from lifecycle_supervisor import exchange, recover_dead_supervisor

SAFE_CODES = {
    'SOURCE_MISSING', 'ARTIFACT_TOO_LARGE', 'CAPTURE_RUNTIME_UNSUPPORTED',
    'CAPTURE_PLATFORM_UNSUPPORTED', 'CAPTURE_INVALID_PATH', 'CAPTURE_READ_FAILED',
    'CAPTURE_NATIVE_SAVE_FAILED', 'CAPTURE_UNAVAILABLE', 'CAPTURE_EXPIRED',
    'CAPTURE_BUSY', 'CAPTURE_DRAIN_TIMEOUT', 'CAPTURE_SUPERVISOR_LOST',
    'CAPTURE_ALREADY_STOPPED', 'CAPTURE_WRITERS_CHANGED', 'CAPTURE_NOT_DRAINED',
}

def main():
    directory = Path(__file__).resolve().parent / "lifecycle"
    try:
        request = json.loads(sys.argv[1])
        capability = json.loads((directory / "capability.json").read_text())
        if not capability.get("supported"):
            if (directory / 'stop.json').exists():
                saved = json.loads((directory / 'stop.json').read_text())
                return {'ok': True, 'state': 'stopped', 'token': saved['token']}
            state = exchange(directory / 'native.sock', {'action': 'status'})
            if request.get('action') == 'status':
                return {**state, 'supported': False}
            return {"ok": False, "code": "CAPTURE_RUNTIME_UNSUPPORTED", 'state': state.get('state')}
        try:
            return exchange(directory / "control.sock", request, timeout=55)
        except (ConnectionRefusedError, FileNotFoundError):
            recovered = recover_dead_supervisor(directory)
            if request.get('action') == 'status':
                return recovered
            if recovered.get('state') == 'running':
                return {'ok': False, 'code': 'CAPTURE_RUNTIME_UNSUPPORTED', 'state': 'running'}
            if request.get('action') == 'commit-stop' and recovered.get('token') == request.get('token'):
                return recovered
            return {'ok': False, 'code': 'CAPTURE_ALREADY_STOPPED'}
    except Exception as error:
        code = str(error)
        if code not in SAFE_CODES:
            code = "CAPTURE_UNAVAILABLE"
        return {"ok": False, "code": code}


if __name__ == "__main__":
    print(json.dumps(main()))
