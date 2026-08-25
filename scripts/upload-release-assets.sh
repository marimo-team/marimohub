#!/usr/bin/env bash

set -euo pipefail

tag="${1:?release tag is required}"
expected_sha="${2:?expected commit SHA is required}"
repository="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
shift 2
if (($# == 0)); then
	echo 'at least one release asset is required' >&2
	exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$script_dir/verify-release-tag.sh" "$tag" "$expected_sha"

release_id=$("$script_dir/retry.sh" gh api \
	"repos/$repository/releases/tags/$tag" --jq .id)
existing_assets=$("$script_dir/retry.sh" gh api --paginate \
	"repos/$repository/releases/$release_id/assets" \
	--jq '.[] | [.id, .name, (.digest // "")] | @tsv')

sha256_file() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk '{ print $1 }'
	else
		shasum -a 256 "$1" | awk '{ print $1 }'
	fi
}

asset_id_exists() {
	local sought_id="$1"
	local listed_id
	local listed_name
	local listed_digest
	while IFS=$'\t' read -r listed_id listed_name listed_digest; do
		if [[ "$listed_id" == "$sought_id" ]]; then
			return 0
		fi
	done <<<"$existing_assets"
	return 1
}

existing_asset_digest() {
	local sought_name="$1"
	local listed_id
	local listed_name
	local listed_digest
	while IFS=$'\t' read -r listed_id listed_name listed_digest; do
		if [[ "$listed_name" == "$sought_name" ]]; then
			printf '%s\n' "$listed_digest"
			return 0
		fi
	done <<<"$existing_assets"
	return 1
}

requested_names=()
upload_assets=()
for asset in "$@"; do
	asset_path="${asset%%#*}"
	asset_name="$(basename "$asset_path")"
	requested_names+=("$asset_name")
	if existing_digest=$(existing_asset_digest "$asset_name"); then
		local_digest="sha256:$(sha256_file "$asset_path")"
		if [[ "$existing_digest" != "$local_digest" ]]; then
			echo "Release asset $asset_name already exists with different contents" >&2
			exit 1
		fi
	else
		upload_assets+=("$asset")
	fi
done

upload_status=0
if ((${#upload_assets[@]} > 0)); then
	gh release upload "$tag" "${upload_assets[@]}" || upload_status=$?
fi

verification_status=0
"$script_dir/verify-release-tag.sh" "$tag" "$expected_sha" || verification_status=$?
if ((verification_status == 1)); then
	cleanup_status=0
	attached_assets=$("$script_dir/retry.sh" gh api --paginate \
		"repos/$repository/releases/$release_id/assets" \
		--jq '.[] | [.id, .name, (.digest // "")] | @tsv') || cleanup_status=$?
	if ((cleanup_status == 0)); then
		while IFS=$'\t' read -r asset_id asset_name _asset_digest; do
			[[ -n "$asset_id" ]] || continue
			asset_id_exists "$asset_id" && continue
			for requested_name in "${requested_names[@]}"; do
				if [[ "$asset_name" == "$requested_name" ]]; then
					"$script_dir/retry.sh" gh api --method DELETE \
						"repos/$repository/releases/assets/$asset_id" || cleanup_status=$?
					break
				fi
			done
		done <<<"$attached_assets"
	fi
	if ((cleanup_status != 0)); then
		echo "Failed to remove assets uploaded after release tag $tag moved" >&2
	fi
fi

if ((upload_status != 0)); then
	exit "$upload_status"
fi
exit "$verification_status"
