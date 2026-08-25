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

upload_status=0
gh release upload "$tag" "$@" --clobber || upload_status=$?

verification_status=0
"$script_dir/verify-release-tag.sh" "$tag" "$expected_sha" || verification_status=$?
if ((verification_status != 0)); then
	cleanup_status=0
	attached_assets=''
	attached_assets=$("$script_dir/retry.sh" gh release view "$tag" \
		--json assets --jq '.assets[].name') || cleanup_status=$?
	if ((cleanup_status == 0)); then
		for asset in "$@"; do
			asset_path="${asset%%#*}"
			asset_name="$(basename "$asset_path")"
			if grep -Fqx -- "$asset_name" <<<"$attached_assets"; then
				"$script_dir/retry.sh" gh release delete-asset \
					"$tag" "$asset_name" --yes || cleanup_status=$?
			fi
		done
	fi
	if ((cleanup_status != 0)); then
		echo "Failed to remove assets uploaded after release tag $tag moved" >&2
	fi
fi

if ((upload_status != 0)); then
	exit "$upload_status"
fi
exit "$verification_status"
