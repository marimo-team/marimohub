#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${MARIMOHUB_KERNEL_URL:-}" ]]; then
  jq -n --arg url "$MARIMOHUB_KERNEL_URL" \
    '[{server_id: "marimohub", origin: "local", url: $url}]'
  exit 0
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec bash "$script_dir/discover-servers-upstream.sh" "$@"
