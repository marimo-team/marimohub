#!/usr/bin/env bash
# Boot a marimohub SEA binary with in-memory storage and check that it serves
# the API and the SPA. Used by release.yml before the binary is attached.
#
#   scripts/smoke-sea.sh apps/server/dist/sea/marimohub-linux-x64 [expected-version]

set -euo pipefail

binary="${1:?path to the marimohub binary is required}"
expected_version="${2:-}"
port="${PORT:-3123}"
# The launcher refuses a cache below a world-writable directory such as /tmp,
# so keep the scratch tree under the user's own cache directory.
mkdir -p "${XDG_CACHE_HOME:-$HOME/.cache}"
cache_dir="$(mktemp -d "${XDG_CACHE_HOME:-$HOME/.cache}/marimohub-sea-smoke.XXXXXX")"
log="$cache_dir/server.log"

cleanup() {
	if [[ -n "${server_pid:-}" ]]; then
		kill "$server_pid" 2>/dev/null || true
		wait "$server_pid" 2>/dev/null || true
	fi
	rm -rf "$cache_dir"
}
trap cleanup EXIT

fail() {
	echo "smoke test failed: $1" >&2
	echo "--- server log ---" >&2
	cat "$log" >&2
	exit 1
}

MARIMOHUB_SEA_CACHE_DIR="$cache_dir/cache" \
	MARIMOHUB_STORAGE_BACKEND=memory \
	MARIMOHUB_ALLOW_EPHEMERAL_STORAGE=true \
	MARIMOHUB_COMPUTE_BACKEND=none \
	MARIMOHUB_AUTH_BACKEND=dev \
	PORT="$port" \
	"$binary" >"$log" 2>&1 &
server_pid=$!

healthy=false
for _ in $(seq 1 60); do
	if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
		healthy=true
		break
	fi
	if ! kill -0 "$server_pid" 2>/dev/null; then
		fail "server exited before becoming healthy"
	fi
	sleep 1
done
if [[ "$healthy" != true ]]; then
	fail "/api/health did not respond within 60s"
fi

version_json="$(curl -fsS "http://127.0.0.1:$port/api/v1/version")" ||
	fail "GET /api/v1/version failed"
echo "version: $version_json"
if [[ -n "$expected_version" && "$version_json" != *"\"$expected_version\""* ]]; then
	fail "expected version $expected_version in /api/v1/version response: $version_json"
fi

index_html="$(curl -fsS "http://127.0.0.1:$port/")" || fail "GET / failed"
if [[ "$index_html" != *"<div id=\"root\">"* ]]; then
	fail "expected the SPA index at /, got: $(printf '%s' "$index_html" | head -c 300)"
fi
echo "smoke test passed"
