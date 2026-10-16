#!/usr/bin/env bash
# Usage: publish-image-manifest.sh IMAGE@sha256:DIGEST... < destination-tags
# Sources are the per-arch digests the build jobs pushed, not their sha-* tags,
# which a re-run of the same commit can repoint between build and publish.
set -euo pipefail

retry="$(dirname "${BASH_SOURCE[0]}")/retry.sh"

if [[ $# -eq 0 ]]; then
	echo 'At least one source image digest is required' >&2
	exit 1
fi
for source in "$@"; do
	if [[ ! "$source" =~ @sha256:[0-9a-f]{64}$ ]]; then
		echo "Source must be an IMAGE@sha256:DIGEST reference: $source" >&2
		exit 1
	fi
done

tags=()
while IFS= read -r tag || [[ -n "$tag" ]]; do
	[[ -n "$tag" ]] && tags+=(--tag "$tag")
done
if [[ ${#tags[@]} -eq 0 ]]; then
	echo 'At least one destination tag is required' >&2
	exit 1
fi

# Fail before any destination tag (latest included) moves.
for source in "$@"; do
	"$retry" docker buildx imagetools inspect "$source" >/dev/null
done

# create is idempotent for the same sources, so retrying a transient registry error is safe.
"$retry" docker buildx imagetools create "${tags[@]}" "$@"
manifest=$("$retry" docker buildx imagetools inspect "${tags[1]}" --raw)
jq -e '
  [.manifests[].platform | select(.os == "linux") | .architecture] | sort == ["amd64", "arm64"]
' <<<"$manifest"
