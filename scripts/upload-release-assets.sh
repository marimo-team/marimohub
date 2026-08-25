#!/usr/bin/env bash

set -euo pipefail

tag="${1:?release tag is required}"
expected_sha="${2:?expected commit SHA is required}"
shift 2
if (($# == 0)); then
	echo 'at least one release asset is required' >&2
	exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$script_dir/verify-release-tag.sh" "$tag" "$expected_sha"
gh release upload "$tag" "$@" --clobber
"$script_dir/verify-release-tag.sh" "$tag" "$expected_sha"
