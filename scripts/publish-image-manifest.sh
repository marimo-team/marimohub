#!/usr/bin/env bash
# Read destination tags from stdin; source images use -amd64 and -arm64 suffixes.
set -euo pipefail

source_image="${1:?source image tag is required}"
tags=()
while IFS= read -r tag || [[ -n "$tag" ]]; do
	[[ -n "$tag" ]] && tags+=(--tag "$tag")
done
if [[ ${#tags[@]} -eq 0 ]]; then
	echo 'At least one destination tag is required' >&2
	exit 1
fi

docker buildx imagetools create "${tags[@]}" "$source_image-amd64" "$source_image-arm64"
docker buildx imagetools inspect "${tags[1]}" --raw | jq -e '
  [.manifests[].platform | select(.os == "linux") | .architecture] | sort == ["amd64", "arm64"]
'
