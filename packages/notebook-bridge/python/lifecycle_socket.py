from contextlib import contextmanager
import os
from pathlib import Path
import sys


@contextmanager
def socket_path(path):
    path = Path(path)
    if sys.platform != 'linux':
        yield str(path)
        return
    # Resolve through an open directory to stay below sun_path's byte limit,
    # without changing cwd or moving sockets outside their private directory.
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        yield f'/proc/self/fd/{descriptor}/{path.name}'
    finally:
        os.close(descriptor)
