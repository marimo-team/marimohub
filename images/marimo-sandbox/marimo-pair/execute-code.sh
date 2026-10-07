#!/usr/bin/env bash
set -euo pipefail

args=("$@")
url="${MARIMOHUB_KERNEL_URL:-}"
explicit_token=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) url="$2"; shift 2 ;;
    --token) explicit_token=true; shift 2 ;;
    --file|--session|-c) shift 2 ;;
    *) break ;;
  esac
done

# A sandbox credential must never follow an explicit URL to another server.
if [[ -n "${MARIMOHUB_KERNEL_URL:-}" && "${url%/}" == "${MARIMOHUB_KERNEL_URL%/}" &&
      -n "${MARIMOHUB_KERNEL_TOKEN_FILE:-}" && -z "${MARIMO_TOKEN:-}" && "$explicit_token" == false ]]; then
  MARIMO_TOKEN=$(cat -- "$MARIMOHUB_KERNEL_TOKEN_FILE")
  export MARIMO_TOKEN
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ -n "${MARIMOHUB_KERNEL_URL:-}" ]]; then
  args=(--url "$MARIMOHUB_KERNEL_URL" ${args[@]+"${args[@]}"})
fi
exec bash "$script_dir/execute-code-upstream.sh" ${args[@]+"${args[@]}"}
