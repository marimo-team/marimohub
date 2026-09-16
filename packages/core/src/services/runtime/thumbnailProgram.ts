// The supervisor stays outside the browser process tree so it can kill descendants on timeout.
export const THUMBNAIL_PROGRAM = String.raw`
import base64, ctypes, json, os, signal, subprocess, sys, time
from pathlib import Path

input_path = Path(sys.argv[1])
deadline = float(sys.argv[2])
worker = r'''
import asyncio, base64, importlib.util, json, mimetypes, os, socket, sys
from pathlib import Path
from urllib.parse import unquote, urlparse

async def render():
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        print(json.dumps({"status": "missing_playwright"})); return
    spec = importlib.util.find_spec("marimo")
    if not spec or not spec.origin:
        print(json.dumps({"status": "missing_marimo"})); return
    static = (Path(spec.origin).parent / "_static").resolve()
    html = Path(sys.argv[1]).read_text()
    origin = "https://thumbnail.invalid"
    async with async_playwright() as pw:
        if not Path(pw.chromium.executable_path).is_file():
            print(json.dumps({"status": "missing_chromium"})); return
        # Routing cannot intercept WebRTC. Reserve a non-listening proxy port and deny direct UDP/DNS.
        with socket.socket() as proxy_socket:
            proxy_socket.bind(("127.0.0.1", 0))
            browser = await pw.chromium.launch(
                chromium_sandbox=True,
                proxy={"server": f"http://127.0.0.1:{proxy_socket.getsockname()[1]}", "bypass": "<-loopback>"},
                args=["--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--host-resolver-rules=MAP * ~NOTFOUND"],
                env={"PATH": os.defpath, "HOME": os.environ.get("HOME", "/tmp")},
            )
            try:
                context = await browser.new_context(viewport={"width": 960, "height": 540}, device_scale_factor=1, color_scheme="light", reduced_motion="reduce", service_workers="block")
                missing_assets = set()
                async def route(request):
                    url = request.request.url
                    path = unquote(urlparse(url).path)
                    if url.startswith(origin + "/snapshot.html") and request.request.resource_type == "document":
                        await request.fulfill(status=200, content_type="text/html", body=html)
                        return
                    # Fulfill installed assets from disk; never proxy an arbitrary URL.
                    suffix = path.split("/assets/", 1)[1] if "/assets/" in path else None
                    if suffix and request.request.method == "GET":
                        asset = (static / "assets" / suffix).resolve()
                        if asset.is_relative_to(static / "assets") and asset.is_file() and asset.stat().st_size < 20_000_000:
                            await request.fulfill(status=200, content_type=mimetypes.guess_type(str(asset))[0] or "application/octet-stream", body=asset.read_bytes())
                            return
                        missing_assets.add(path)
                    await request.abort()
                await context.route("**/*", route)
                await context.route_web_socket("**/*", lambda ws: ws.close())
                page = await context.new_page()
                await page.goto(origin + "/snapshot.html?show-code=false", wait_until="load", timeout=5000)
                await page.locator('[id^="output-"]').first.wait_for(state="visible", timeout=3000)
                await page.add_style_tag(content=".cm-editor, .marimo-code, .print\\:hidden { display: none !important; } body { background: white !important; }")
                await page.evaluate("document.fonts.ready")
                await page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
                if missing_assets:
                    raise RuntimeError("Snapshot assets do not match installed marimo")
                image = await page.screenshot(type="png", animations="disabled", timeout=1500)
                if missing_assets:
                    raise RuntimeError("Snapshot asset failed during capture")
                print(json.dumps({"status": "ok", "png": base64.b64encode(image).decode()}))
            finally:
                await browser.close()
try:
    asyncio.run(render())
except Exception:
    print(json.dumps({"status": "render_failed"}))
'''

def descendants(root):
    parents = {}
    if sys.platform == 'darwin':
        try:
            rows = subprocess.check_output(['ps', '-axo', 'pid=,ppid='], timeout=0.25).decode().splitlines()
        except (OSError, subprocess.SubprocessError):
            rows = []
        for line in rows:
            pid, parent = line.split()
            parents[int(pid)] = int(parent)
    for entry in Path('/proc').glob('[0-9]*/stat'):
        try:
            fields = entry.read_text().rsplit(')', 1)[1].split()
            parents[int(entry.parent.name)] = int(fields[1])
        except (OSError, ValueError, IndexError):
            pass
    found = {root}
    while True:
        more = {pid for pid, parent in parents.items() if parent in found}
        if more.issubset(found):
            return found
        found |= more

process = None
tracked = set()
if sys.platform == 'linux':
    # Adopt detached browser grandchildren even when the worker exits first.
    ctypes.CDLL(None).prctl(36, 1, 0, 0, 0)
try:
    remaining = deadline - time.time()
    if remaining < 1 or sys.platform not in ('linux', 'darwin'):
        print(json.dumps({"status": "insufficient_budget"})); sys.exit(0)
    process = subprocess.Popen([sys.executable, '-c', worker, str(input_path)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        while True:
            tracked |= descendants(os.getpid()) - {os.getpid()}
            budget = deadline - time.time() - 0.5
            if budget <= 0:
                raise subprocess.TimeoutExpired(process.args, remaining)
            try:
                out, _ = process.communicate(timeout=min(0.05, budget))
                break
            except subprocess.TimeoutExpired:
                continue
        print(out.decode().strip() if out else json.dumps({"status": "render_failed"}))
    except subprocess.TimeoutExpired:
        print(json.dumps({"status": "timeout"}))
finally:
    input_path.unlink(missing_ok=True)
    if process:
        # Freeze the supervisor's child before collecting descendants, including detached Chromium processes.
        try: os.kill(process.pid, signal.SIGSTOP)
        except ProcessLookupError: pass
        try:
            tracked |= descendants(os.getpid()) - {os.getpid()}
            for pid in reversed(sorted(tracked)):
                try: os.kill(pid, signal.SIGKILL)
                except ProcessLookupError: pass
        finally:
            try: os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            process.wait(timeout=0.25)
`;
