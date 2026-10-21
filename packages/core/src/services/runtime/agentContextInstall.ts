import { AGENT_HOME_FILES_MANIFEST } from '../integrations/agentContext';

// Directory handles and atomic replacement prevent a concurrent symlink swap from redirecting writes.
export const INSTALL_AGENT_CONTEXT = String.raw`# marimohub-agent-context-install
import contextlib, errno, json, os, re, secrets, stat, sys

MANIFEST = ${JSON.stringify(AGENT_HOME_FILES_MANIFEST)}
MISSING = object()

class Invalid(Exception):
    pass

def absolute(value, reason):
    if (not isinstance(value, str) or not value.startswith('/') or
        len(value.encode('utf-8')) >= 4096 or '\\' in value or
        any(ord(c) < 32 or ord(c) == 127 for c in value) or
        (value != '/' and any(p in ('', '.', '..') for p in value.split('/')[1:]))):
        raise Invalid(reason)
    return value

def skill_path(value):
    if value in ('.claude/CLAUDE.md', '.claude/settings.json'):
        return
    match = re.fullmatch(r'\.(?:agents|claude)/skills/([a-z0-9-]{1,64})/SKILL\.md', value)
    if not match or match[1] == 'marimo-pair':
        raise Invalid('unsafe_path')

def read_json(parent, name):
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    except FileNotFoundError:
        return MISSING
    with os.fdopen(fd, 'r', encoding='utf-8') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise Invalid('unsafe_path')
        return json.load(stream)

def install(payload):
    root = os.path.realpath(payload['root'])
    workspace = absolute(payload['workdir'], 'unsafe_path')
    workspace_real = os.path.realpath(os.path.join(root, workspace.lstrip('/')))
    if os.path.commonpath((root, workspace_real)) != root:
        raise Invalid('unsafe_path')
    files = payload['files']
    home = payload.get('home', os.environ.get('HOME') or '/home/appuser')
    if files:
        if workspace == '/':
            raise Invalid('root_workspace')
        if isinstance(home, str) and home != '/' and home.endswith('/'):
            home = home[:-1]
        absolute(home, 'invalid_home')

    def outside(path):
        physical = os.path.join(root, path.lstrip('/'))
        if os.path.commonpath((workspace_real, physical)) == workspace_real:
            raise Invalid('unsafe_path')

    def target(home, relative):
        if not isinstance(relative, str):
            raise Invalid('unsafe_path')
        skill_path(relative)
        path = home.rstrip('/') + '/' + relative
        outside(path)
        return path

    with contextlib.ExitStack() as stack:
        def keep(fd):
            stack.callback(os.close, fd)
            return fd

        directories = {'/': keep(os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW))}

        def parent(path, create=False):
            parts = path.split('/')[1:]
            prefix = ''
            fd = directories['/']
            for part in parts[:-1]:
                prefix += '/' + part
                if prefix not in directories:
                    try:
                        child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    except FileNotFoundError:
                        if not create:
                            return None
                        try:
                            os.mkdir(part, 0o700, dir_fd=fd)
                        except FileExistsError:
                            pass
                        child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    directories[prefix] = keep(child)
                fd = directories[prefix]
            try:
                mode = os.stat(parts[-1], dir_fd=fd, follow_symlinks=False).st_mode
                if not stat.S_ISREG(mode):
                    raise Invalid('unsafe_path')
            except FileNotFoundError:
                pass
            return (fd, parts[-1])

        previous = MISSING
        if payload['restored']:
            location = parent(MANIFEST)
            if location:
                try:
                    previous = read_json(*location)
                except (ValueError, UnicodeError):
                    raise Invalid('invalid_manifest')
        old_paths = []
        if previous is not MISSING:
            if (not isinstance(previous, dict) or set(previous) != {'home', 'paths'} or
                not isinstance(previous['paths'], list)):
                raise Invalid('invalid_manifest')
            absolute(previous['home'], 'invalid_manifest')
            old_paths = [target(previous['home'], relative) for relative in previous['paths']]
        current = {target(home, file['path']): file['content'] for file in files}
        if any(not isinstance(content, str) for content in current.values()):
            raise Invalid('unsafe_path')
        stale = [path for path in old_paths if path not in current]
        if current:
            outside(MANIFEST)
            current[MANIFEST] = json.dumps({'home': home, 'paths': [file['path'] for file in files]})
        elif previous is not MISSING:
            outside(MANIFEST)
            stale.append(MANIFEST)

        # Validate every destination before removing any file from a restored snapshot.
        locations = {path: parent(path, path in current) for path in dict.fromkeys(stale + list(current))}
        for path in stale:
            location = locations[path]
            if location:
                try:
                    os.unlink(location[1], dir_fd=location[0])
                except FileNotFoundError:
                    pass
        for path, content in current.items():
            fd, name = locations[path]
            temporary = '.marimohub-agent-' + secrets.token_hex(16)
            try:
                output = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
                with os.fdopen(output, 'w', encoding='utf-8') as stream:
                    stream.write(content)
                os.replace(temporary, name, src_dir_fd=fd, dst_dir_fd=fd)
            finally:
                try:
                    os.unlink(temporary, dir_fd=fd)
                except FileNotFoundError:
                    pass

payload_path = None
try:
    if sys.argv[1] == '--inline':
        payload = json.loads(sys.argv[2])
        if payload.get('files') != []:
            raise Invalid('unsafe_path')
        install(payload)
    else:
        payload_path = sys.argv[1]
        payload_fd = os.open(payload_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(payload_fd, 'r', encoding='utf-8') as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise Invalid('unsafe_path')
            install(json.load(stream))
except Invalid as error:
    print(str(error))
    sys.exit(1)
except OSError as error:
    print('unsafe_path' if error.errno in (errno.ELOOP, errno.ENOTDIR) else 'io_error')
    sys.exit(1)
except Exception:
    print('io_error')
    sys.exit(1)
finally:
    if payload_path is not None:
        try:
            os.unlink(payload_path)
        except OSError:
            pass
`;
