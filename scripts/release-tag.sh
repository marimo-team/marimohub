#!/usr/bin/env bash
# Release tag policy, shared by .github/workflows/release.yml and its tests.
#   release-tag.sh validate TAG   prints the version (TAG without "v") or fails
#   release-tag.sh floating TAG   reads existing tags on stdin and prints
#                                 latest=, major=, minor= (true|false) for $GITHUB_OUTPUT
set -euo pipefail

# Stable releases only: the `v*.*.*` trigger glob also matches v1.2.3-rc.1, and
# a stray tag cannot be deleted under the repository rulesets.
stable_tag='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'

command="${1:?usage: release-tag.sh validate|floating TAG}"
tag="${2:?release tag is required}"

if [[ ! "$tag" =~ $stable_tag ]]; then
	echo "Invalid release tag: $tag (expected vMAJOR.MINOR.PATCH)" >&2
	exit 1
fi
major="${BASH_REMATCH[1]}"
minor="${BASH_REMATCH[2]}"

# True when TAG is the highest stable tag among those starting with $1.
is_highest() {
	local prefix="$1" candidate highest
	highest=$(
		for candidate in "$tag" ${existing[@]+"${existing[@]}"}; do
			[[ "$candidate" =~ $stable_tag && "$candidate" == "$prefix"* ]] && printf '%s\n' "${candidate#v}"
		done | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1
	)
	[[ "v$highest" == "$tag" ]]
}

case "$command" in
validate)
	printf '%s\n' "${tag#v}"
	;;
floating)
	existing=()
	while IFS= read -r line || [[ -n "$line" ]]; do
		[[ -n "$line" ]] && existing+=("$line")
	done
	for scope in latest:v major:"v$major." minor:"v$major.$minor."; do
		if is_highest "${scope#*:}"; then
			printf '%s=true\n' "${scope%%:*}"
		else
			printf '%s=false\n' "${scope%%:*}"
		fi
	done
	;;
*)
	echo "Unknown command: $command" >&2
	exit 2
	;;
esac
