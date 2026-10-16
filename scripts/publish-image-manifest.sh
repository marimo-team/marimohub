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

# Before any destination tag (latest included) moves, every source must resolve to an
# index and their linux entries together must be exactly amd64 and arm64, the same
# predicate the post-create check applies. Attestation entries (unknown/unknown) are
# ignored. build-push-action's provenance attestation makes each per-arch digest an index.
source_manifests=''
for source in "$@"; do
	source_manifests+=$("$retry" docker buildx imagetools inspect "$source" --raw)
	source_manifests+=$'\n'
done
if ! jq -se '
  [.[].manifests[].platform | select(.os == "linux") | .architecture] | sort == ["amd64", "arm64"]
' <<<"$source_manifests" >/dev/null; then
	echo 'Source digests must together cover exactly linux/amd64 and linux/arm64' >&2
	exit 1
fi

# create is idempotent for the same sources, so retrying a transient registry error is safe.
"$retry" docker buildx imagetools create "${tags[@]}" "$@"
manifest=$("$retry" docker buildx imagetools inspect "${tags[1]}" --raw)
jq -e '
  [.manifests[].platform | select(.os == "linux") | .architecture] | sort == ["amd64", "arm64"]
' <<<"$manifest"
