# Runtime env for the marimo kernel, installed to /etc/profile.d/ by build.mjs.
# The boxd compute backend runs commands in a login shell, so these values reach
# the kernel launch (chiefly UV_PROJECT_ENVIRONMENT, so `uv run --no-sync` uses
# the pre-installed /opt/venv).
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
export UV_PROJECT_ENVIRONMENT=/opt/venv
export UV_CACHE_DIR=/opt/uv-cache
export VIRTUAL_ENV=/opt/venv
export PATH=/opt/venv/bin:$PATH
export MARIMO_SKIP_UPDATE_CHECK=1
export _MARIMO_APP_OVERLOAD_AUTO_DOWNLOAD=[html]
