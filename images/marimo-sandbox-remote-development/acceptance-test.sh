#!/usr/bin/env bash
set -euo pipefail

image=${1:-marimo-sandbox-remote-development:acceptance}
platform=${MARIMOHUB_REMOTE_DEVELOPMENT_PLATFORM:-linux/amd64}
root=$(cd "$(dirname "$0")" && pwd)
if [ -n "${MARIMOHUB_REMOTE_DEVELOPMENT_BASE_IMAGE:-}" ]; then
	docker build --platform "$platform" \
		--build-arg "BASE_IMAGE=$MARIMOHUB_REMOTE_DEVELOPMENT_BASE_IMAGE" -t "$image" "$root"
else
	docker build --platform "$platform" -t "$image" "$root"
fi
container=$(docker run --platform "$platform" -d -p 127.0.0.1::2222 "$image" sleep infinity)
replacement=''
tmp=$(mktemp -d)
cleanup() {
	docker rm -f "$container" >/dev/null 2>&1 || true
	if [ -n "$replacement" ]; then
		docker rm -f "$replacement" >/dev/null 2>&1 || true
	fi
	rm -rf "$tmp"
}
trap cleanup EXIT
ssh-keygen -q -t ed25519 -N '' -f "$tmp/id"
ssh-keygen -q -t ed25519 -N '' -f "$tmp/wrong-id"
expires=$(date -u -v+10M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+10 minutes' +%Y-%m-%dT%H:%M:%SZ)
docker cp "$tmp/id.pub" "$container:/tmp/key.pub"
prepared=$(docker exec "$container" marimohub-ssh prepare \
	--public-key-file /tmp/key.pub --expires-at "$expires" --workspace /workspace)
host_key=$(printf '%s' "$prepared" | sed -n 's/.*"host_key":"\([^"]*\)".*/\1/p')
printf 'sandbox %s\n' "$host_key" > "$tmp/known_hosts"
port=$(docker port "$container" 2222/tcp | sed 's/.*://')
ssh_args=(-i "$tmp/id" -p "$port" -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
	-o UserKnownHostsFile="$tmp/known_hosts" -o HostKeyAlias=sandbox \
	-o ConnectTimeout=5 appuser@127.0.0.1)
result=$(ssh "${ssh_args[@]}" pwd)
[ "$result" = /workspace ]
[ "$(docker exec "$container" id -u)" != 0 ]

docker exec "$container" sh -c "printf \"export MARIMOHUB_TEST_ENV='present'\\n\" > /tmp/marimohub-ssh/session-env"
[ "$(ssh "${ssh_args[@]}" 'printf %s "$MARIMOHUB_TEST_ENV"')" = present ]
pty=$(ssh -tt "${ssh_args[@]}" 'test -t 0 && printf pty')
[[ "$pty" = *pty* ]]

docker exec -d "$container" python3 -m http.server 8765 --bind 127.0.0.1 --directory /workspace
local_port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
ssh -f -N -L "$local_port:127.0.0.1:8765" "${ssh_args[@]}"
curl --fail --silent --retry 5 --retry-delay 1 "http://127.0.0.1:$local_port/" >/dev/null

if ssh -o BatchMode=yes -o PreferredAuthentications=password -o PubkeyAuthentication=no \
	-o StrictHostKeyChecking=yes -o UserKnownHostsFile="$tmp/known_hosts" -o HostKeyAlias=sandbox \
	-p "$port" appuser@127.0.0.1 true 2>/dev/null; then
	echo 'password authentication unexpectedly succeeded' >&2
	exit 1
fi
if ssh -i "$tmp/wrong-id" -o BatchMode=yes -o IdentitiesOnly=yes \
	-o StrictHostKeyChecking=yes -o UserKnownHostsFile="$tmp/known_hosts" -o HostKeyAlias=sandbox \
	-p "$port" appuser@127.0.0.1 true 2>/dev/null; then
	echo 'unauthorized SSH key unexpectedly succeeded' >&2
	exit 1
fi
if ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -R 0:127.0.0.1:8765 \
	"${ssh_args[@]}" 2>/dev/null; then
	echo 'remote port forwarding unexpectedly succeeded' >&2
	exit 1
fi
[ -z "$(docker exec "$container" find /workspace /home/appuser \( -name '*ssh_host*' -o -name authorized_keys \))" ]

if docker exec "$container" marimohub-ssh prepare --unknown value 2>/dev/null; then
	echo 'unknown helper argument unexpectedly succeeded' >&2
	exit 1
fi

expired=$(date -u -v-1M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '-1 minute' +%Y-%m-%dT%H:%M:%SZ)
docker exec "$container" marimohub-ssh prepare \
	--public-key-file /tmp/key.pub --expires-at "$expired" --workspace /workspace >/dev/null
if ssh -o BatchMode=yes "${ssh_args[@]}" true 2>/dev/null; then
	echo 'expired SSH key unexpectedly succeeded' >&2
	exit 1
fi

replacement=$(docker run --platform "$platform" -d "$image" sleep infinity)
docker cp "$tmp/id.pub" "$replacement:/tmp/key.pub"
replacement_prepared=$(docker exec "$replacement" marimohub-ssh prepare \
	--public-key-file /tmp/key.pub --expires-at "$expires" --workspace /workspace)
replacement_host_key=$(printf '%s' "$replacement_prepared" | sed -n 's/.*"host_key":"\([^"]*\)".*/\1/p')
docker rm -f "$replacement" >/dev/null
replacement=''
[ "$host_key" != "$replacement_host_key" ]
