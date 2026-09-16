import contextlib
import html
import importlib.resources
import os
import logging
from urllib.parse import urlsplit


@contextlib.asynccontextmanager
async def lifespan(app):
    marker = 'data-marimohub-bridge="1"'
    previous = None
    injected = None
    try:
        origin = os.environ.get("MARIMOHUB_BRIDGE_PARENT_ORIGIN", "")
        parsed = urlsplit(origin)
        if (parsed.scheme in ("http", "https") and parsed.netloc
                and not parsed.path and not parsed.query and not parsed.fragment
                and not parsed.username and not parsed.password):
            previous = getattr(app.state, "html_head", None)
            if previous is None or isinstance(previous, str):
                if marker not in (previous or ""):
                    script = importlib.resources.files(__package__).joinpath("bridge.js").read_text()
                    script = script.replace("</script", "<\\/script")
                    head = (previous or "") + (
                        f'<script {marker} data-parent-origin="{html.escape(origin, quote=True)}">'
                        + script + "</script>"
                    )
                    app.state.html_head = head
                    injected = head
            else:
                logging.getLogger(__name__).warning('{"event":"notebook_bridge_unavailable","reason":"unsupported_extension_state"}')
    except Exception:
        # Optional integration must not prevent marimo's server from starting.
        logging.getLogger(__name__).warning('{"event":"notebook_bridge_unavailable","reason":"injection_failed"}')
    try:
        yield
    finally:
        if injected is not None:
            try:
                state = getattr(app, "state", None)
                if getattr(state, "html_head", None) == injected:
                    state.html_head = previous
            except Exception:
                logging.getLogger(__name__).warning('{"event":"notebook_bridge_unavailable","reason":"cleanup_failed"}')
