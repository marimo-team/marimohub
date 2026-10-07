#!/usr/bin/env bash
set -euo pipefail

port="${1:-4096}"
log="$(mktemp)"
pid=''
cleanup() {
	status=$?
	if [ "$status" -ne 0 ]; then
		echo 'OpenCode verification failed; server log:' >&2
		cat "$log" >&2
	fi
	if [ -n "$pid" ]; then
		kill "$pid" 2>/dev/null || true
		# Reap the server without letting an ignored SIGTERM stall cleanup.
		for ((attempt = 0; attempt < 20; attempt++)); do
			kill -0 "$pid" 2>/dev/null || break
			sleep 0.1
		done
		kill -KILL "$pid" 2>/dev/null || true
		wait "$pid" 2>/dev/null || true
	fi
	rm -f "$log"
	exit "$status"
}
trap cleanup EXIT
trap 'exit 124' TERM
trap 'exit 130' INT

opencode web --hostname 127.0.0.1 --port "$port" >"$log" 2>&1 &
pid=$!
health_deadline="${OPENCODE_HEALTH_DEADLINE:-60}"
deadline=$((SECONDS + health_deadline))
echo 'Waiting for OpenCode health'
until curl --connect-timeout 2 --max-time 3 -fsS "http://127.0.0.1:$port/global/health" >/dev/null; do
	if ! kill -0 "$pid" 2>/dev/null; then
		server_status=0
		wait "$pid" || server_status=$?
		pid=''
		echo "OpenCode exited with status $server_status before becoming healthy (server alive: no)" >&2
		exit 1
	fi
	if [ "$SECONDS" -ge "$deadline" ]; then
		echo "OpenCode health not ready within ${health_deadline}s (server alive: yes)" >&2
		exit 1
	fi
	sleep 1
done

echo 'Checking OpenCode skill discovery'
curl --connect-timeout 2 --max-time 10 -fsS \
	-H 'x-opencode-directory: /workspace' "http://127.0.0.1:$port/skill" \
	| jq -e '.[] | select(.name == "marimo-pair")' >/dev/null
