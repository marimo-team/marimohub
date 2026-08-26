#!/usr/bin/env bash
#
# Acceptance tests for a marimohub sandbox image (the per-kernel container set as
# MARIMOHUB_COMPUTE_IMAGE). Builds the image at CONTEXT and asserts the contract
# from docs/sandbox-image.md: the right tools are present, a marimo kernel starts
# and serves on 2718 via the real launch flow, the warm uv cache makes startup a
# cache hit, `--convert` opens non-marimo files, and a bare `docker run` works.
#
# The launch flow mirrors the active strategy in
# packages/core/src/services/runtime/marimoLaunch.ts (`uv-sync-edit`): checked
# `uv sync`, followed by `uv run --no-sync marimo edit`.
#
# Usage:  acceptance-test.sh [IMAGE_TAG] [CONTEXT_DIR]
#   IMAGE_TAG    tag to build/test          (default: marimo-sandbox:acceptance)
#   CONTEXT_DIR  Dockerfile build context   (default: this script's dir)
# Env:  SKIP_BUILD=1  test an already-built tag instead of rebuilding.
#
# Requires: docker, curl. Exits non-zero on the first failed assertion.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
IMAGE="${1:-marimo-sandbox:acceptance}"
CONTEXT="${2:-$HERE}"

# --- tiny test harness -------------------------------------------------------
PASS=0
fail() {
	echo "  ✗ FAIL: $*" >&2
	exit 1
}
ok() {
	echo "  ✓ $*"
	PASS=$((PASS + 1))
}

# Track containers so we always clean up, even on failure.
CONTAINERS=()
cleanup() {
	for c in "${CONTAINERS[@]:-}"; do
		[ -n "$c" ] && docker rm -f "$c" >/dev/null 2>&1 || true
	done
}
trap cleanup EXIT

run_detached() { # echoes container id; $@ = args after image
	local cid
	cid="$(docker run -d "$@")"
	CONTAINERS+=("$cid")
	echo "$cid"
}

# Poll the kernel's published port until it serves a page (mirrors the
# provisioner's waitForPort). marimo redirects `/` (303 → /auth/login) so we
# follow redirects (-L) and require a final 200. Fails after ~90s.
wait_http_200() { # $1 = host port
	local port="$1" i code
	for i in $(seq 1 90); do
		code="$(curl -sSL -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/" 2>/dev/null || true)"
		[ "$code" = "200" ] && return 0
		sleep 1
	done
	return 1
}

# Lay out /workspace the way the provisioner does: a marimo notebook
# (deps NOT inline — marimohub stores them in pyproject.toml) plus a pyproject
# that declares them.
provision_notebook() { # $1 = container id
	# `-i` keeps stdin open so the heredoc reaches `cat` inside the container;
	# without it docker exec discards stdin and writes an empty file.
	docker exec -i "$1" sh -lc 'cd /workspace && cat > notebook.py' <<'PY'
import marimo

app = marimo.App()


@app.cell
def _():
    import polars as pl

    pl.DataFrame({"a": [1, 2, 3]})
    return


if __name__ == "__main__":
    app.run()
PY
	# Only the user's libraries — marimo is pre-installed in the image's env.
	docker exec -i "$1" sh -lc 'cd /workspace && cat > pyproject.toml' <<'TOML'
[project]
name = "nb"
version = "0.1.0"
requires-python = ">=3.13"
dependencies = ["polars", "narwhals"]
TOML
}

provision_python314_notebook() { # $1 = container id; $2 = image marimo version
	local marimo_version="$2"
	docker exec -i "$1" sh -lc 'cd /workspace && cat > notebook.py' <<PY
# /// script
# requires-python = ">=3.14"
# dependencies = ["click", "marimo!=${marimo_version}"]
# ///

import marimo
PY
	docker exec -i "$1" sh -lc 'cd /workspace && cat > pyproject.toml' <<'TOML'
[project]
name = "python-314-notebook"
version = "0.1.0"
requires-python = ">=3.14"
dependencies = ["requests"]
TOML
}

# Start marimo via the active `uv-sync-edit` launch flow (mirrors marimoLaunch.ts),
# detached, logging to /tmp/m.log.
launch_kernel() { # $1 = container id
	docker exec "$1" sh -lc '
		cd /workspace
		[ ! -s pyproject.toml ] || uv sync --inexact --no-compile-bytecode --no-build
	'
	docker exec -d "$1" sh -lc '
		cd /workspace
		uv run --no-sync marimo edit notebook.py \
			--convert --headless --no-token --host 0.0.0.0 --port 2718 >/tmp/m.log 2>&1
	'
}

# --- build -------------------------------------------------------------------
if [ "${SKIP_BUILD:-0}" != "1" ]; then
	echo "==> Building $IMAGE from $CONTEXT"
	docker build -t "$IMAGE" "$CONTEXT"
fi

# --- 1. contract: tools + writable non-root workdir --------------------------
echo "==> 1. Image contract"
docker run --rm "$IMAGE" sh -lc '
	set -e
	command -v uv >/dev/null   || { echo "uv missing"; exit 1; }
	command -v git >/dev/null  || { echo "git missing"; exit 1; }
	command -v base64 >/dev/null || { echo "base64 missing"; exit 1; }
	test -w /workspace || { echo "/workspace not writable"; exit 1; }
	[ "$(id -u)" != "0" ] || { echo "running as root"; exit 1; }
' || fail "image contract not satisfied (uv/git/coreutils/writable non-root workdir)"
ok "uv + git + coreutils present; /workspace writable; non-root"

# --- 2. pre-installed env: marimo + base libs ready with no install ----------
echo "==> 2. Pre-installed env (fast startup)"
# marimo + base libs must already be importable from the env (not just cached), so
# the base case starts with no build.
docker run --rm "$IMAGE" sh -lc 'cd /workspace && uv run --no-sync python -c "import marimo, polars, narwhals"' \
	|| fail "image does not pre-install marimo + base libraries into the project env"
ok "marimo + base libs pre-installed (importable, no build → fast base-case startup)"
cid="$(run_detached "$IMAGE" sleep infinity)"
provision_notebook "$cid"
# The launch setup step (`uv sync --inexact`) must add the notebook's deps without
# removing the pre-installed base, and download little — the base is already there.
docker exec "$cid" sh -lc 'cd /workspace && uv sync --inexact >/tmp/sync.log 2>&1' \
	|| { docker exec "$cid" sh -lc 'tail -10 /tmp/sync.log'; fail "uv sync --inexact failed"; }
docker exec "$cid" sh -lc 'cd /workspace && uv run --no-sync python -c "import marimo, polars"' \
	|| fail "marimo or base lib missing after uv sync --inexact (base was removed?)"
dl="$(docker exec "$cid" sh -lc 'grep -ic "Downloading" /tmp/sync.log || true')"
[ "${dl:-99}" -le 5 ] || fail "uv sync --inexact downloaded $dl wheels (expected ≤5; base is pre-installed)"
ok "uv sync --inexact keeps the base and adds notebook deps (downloaded $dl)"
docker rm -f "$cid" >/dev/null 2>&1

# --- 2b. marimo is pinned to the image's baked version -----------------------
echo "==> 2b. Pinned marimo (no auto-upgrade)"
mv="$(docker run --rm "$IMAGE" sh -lc 'printf %s "$MARIMO_VERSION"')"
[ -n "$mv" ] || fail "image does not set MARIMO_VERSION — marimo is not pinned"
got="$(docker run --rm "$IMAGE" sh -lc 'cd /workspace && uv run --no-sync python -c "import marimo; print(marimo.__version__)" 2>/dev/null | tail -1')"
[ "$got" = "$mv" ] || fail "pre-installed marimo is ${got:-none}, expected pinned $mv"
ok "marimo pinned to $mv (pre-installed; launch never upgrades it)"

# --- 2c. a notebook may replace the warm env with a newer Python ------------
echo "==> 2c. Python-version replacement"
cid="$(run_detached "$IMAGE" sleep infinity)"
provision_python314_notebook "$cid" "$mv"
docker exec "$cid" sh -lc '
	set -e
	cd /workspace
	marimohub_marimo_version="${MARIMO_VERSION:-$(python3 -c "import importlib.metadata as m;print(m.version(\"marimo\"))")}"
	uv sync --inexact --no-compile-bytecode --no-build
	installed_marimo="$(uv run --no-sync python -c "import importlib.metadata as m;print(m.version(\"marimo\"))" 2>/dev/null || true)"
	[ "$installed_marimo" = "$marimohub_marimo_version" ] || \
		uv pip install --python "$UV_PROJECT_ENVIRONMENT" --no-build \
			"marimo==$marimohub_marimo_version"
	uv export --script notebook.py --format requirements-txt --no-hashes --prune marimo \
		-o "$UV_PROJECT_ENVIRONMENT/marimohub-script-requirements.txt"
	uv pip install --python "$UV_PROJECT_ENVIRONMENT" --no-build \
		-r "$UV_PROJECT_ENVIRONMENT/marimohub-script-requirements.txt"
	uv run --no-sync python -c \
		"import click,marimo,os,sys; assert sys.version_info[:2] >= (3,14); assert marimo.__version__ == os.environ[\"MARIMO_VERSION\"]"
' || fail "uv could not replace the warm environment with Python 3.14"
ok "Python 3.14 replaces the warm environment and starts with script pins"
docker rm -f "$cid" >/dev/null 2>&1

# --- 3. provisioner flow: kernel serves HTTP 200 on 2718 ---------------------
echo "==> 3. Kernel serves via the uv-sync-edit launch flow"
cid="$(run_detached -p 127.0.0.1:2718:2718 "$IMAGE" sleep infinity)"
provision_notebook "$cid"
launch_kernel "$cid"
wait_http_200 2718 || { docker exec "$cid" sh -lc 'tail -20 /tmp/m.log' || true; fail "kernel did not serve HTTP 200 on 2718"; }
ok "marimo kernel serves HTTP 200 via uv sync + uv run"
docker rm -f "$cid" >/dev/null 2>&1

# --- 4. --convert rescues a non-marimo python file (no pyproject) ------------
echo "==> 4. --convert opens a non-marimo file"
cid="$(run_detached -p 127.0.0.1:2719:2718 "$IMAGE" sleep infinity)"
docker exec "$cid" sh -lc 'cd /workspace && printf "import marimo\n" > notebook.py'
launch_kernel "$cid"
wait_http_200 2719 || { docker exec "$cid" sh -lc 'tail -20 /tmp/m.log' || true; fail "--convert did not open the non-marimo file"; }
ok "--convert serves a plain Python file with no pyproject (HTTP 200)"
docker rm -f "$cid" >/dev/null 2>&1

# --- 5. bare `docker run` (default CMD) serves -------------------------------
echo "==> 5. Default CMD (bare docker run)"
cid="$(run_detached -p 127.0.0.1:2720:2718 "$IMAGE")"
wait_http_200 2720 || { docker logs "$cid" 2>&1 | tail -20 || true; fail "default CMD did not serve HTTP 200"; }
ok "bare 'docker run' starts a kernel (HTTP 200)"
docker rm -f "$cid" >/dev/null 2>&1

echo
echo "All $PASS acceptance checks passed ✅ ($IMAGE)"
