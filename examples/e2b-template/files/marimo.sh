# Runtime env for the marimo kernel, baked to /etc/profile.d/ by template.mjs.
# E2B runs commands in a login shell that sources /etc/profile.d/*.sh, but its
# /etc/profile resets PATH and does not carry the template's build-time env — so
# the values the launch needs (chiefly UV_PROJECT_ENVIRONMENT, so `uv run
# --no-sync` uses the pre-installed /opt/venv) must live here to reach the kernel.
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8
export LANGUAGE=en_US:en
export UV_PROJECT_ENVIRONMENT=/opt/venv
export UV_CACHE_DIR=/opt/uv-cache
export VIRTUAL_ENV=/opt/venv
export PATH=/opt/venv/bin:$PATH
export MARIMO_SKIP_UPDATE_CHECK=1
export _MARIMO_APP_OVERLOAD_AUTO_DOWNLOAD=[html]
