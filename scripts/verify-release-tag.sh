#!/usr/bin/env bash

set -euo pipefail

tag="${1:?release tag is required}"
expected_sha="${2:?expected commit SHA is required}"
repository="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

actual_sha=$(gh api "repos/$repository/commits/$tag" --jq .sha)
if [[ "$actual_sha" != "$expected_sha" ]]; then
	echo "Release tag $tag moved from $expected_sha to $actual_sha" >&2
	exit 1
fi
