#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT

archives=(
	mohub-aarch64-apple-darwin.tar.gz
	mohub-aarch64-unknown-linux-gnu.tar.gz
	mohub-x86_64-apple-darwin.tar.gz
	mohub-x86_64-pc-windows-msvc.zip
	mohub-x86_64-unknown-linux-gnu.tar.gz
)

fail() {
	echo "$1" >&2
	exit 1
}

sha256_file() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk '{ print $1 }'
	else
		shasum -a 256 "$1" | awk '{ print $1 }'
	fi
}

make_source() {
	local directory="$1"
	mkdir -p "$directory/artifacts"
	for archive in "${archives[@]}"; do
		printf 'contents for %s\n' "$archive" >"$directory/artifacts/$archive"
		printf '%s  %s\n' \
			"$(sha256_file "$directory/artifacts/$archive")" \
			"$archive" >"$directory/artifacts/$archive.sha256"
	done
}

bash -n "$repo_root/scripts/retry.sh"
bash -n "$repo_root/scripts/stage-cli-release-assets.sh"
bash -n "$repo_root/scripts/upload-release-assets.sh"
bash -n "$repo_root/scripts/verify-release-tag.sh"

verification_bin="$temporary/verification-bin"
mkdir "$verification_bin"
printf '%s\n' \
	'#!/usr/bin/env bash' \
	'printf "%s\n" "$*" >> "${MOCK_GH_LOG:-/dev/null}"' \
	'if [[ "$1" == "api" ]]; then' \
	'  if [[ -n "${MOCK_TAG_MOVED_STATE:-}" && -f "$MOCK_TAG_MOVED_STATE" ]]; then' \
	'    printf "%s\n" "$MOCK_MOVED_RELEASE_SHA"' \
	'  else' \
	'    printf "%s\n" "$MOCK_RELEASE_SHA"' \
	'  fi' \
	'  exit 0' \
	'fi' \
	'if [[ "$1" == "release" && "$2" == "upload" ]]; then' \
	'  status="${MOCK_UPLOAD_EXIT:-0}"' \
	'  uploaded=0' \
	'  for asset in "${@:4}"; do' \
	'    [[ "$asset" != "--clobber" ]] || break' \
	'    ((uploaded += 1))' \
	'    if ((uploaded > ${MOCK_UPLOAD_LIMIT:-999})); then break; fi' \
	'    if [[ -n "${MOCK_ASSET_STATE:-}" ]]; then' \
	'      mkdir -p "$MOCK_ASSET_STATE"' \
	'      asset_path="${asset%%#*}"' \
	'      touch "$MOCK_ASSET_STATE/$(basename "$asset_path")"' \
	'    fi' \
	'  done' \
	'  [[ -z "${MOCK_TAG_MOVED_STATE:-}" ]] || touch "$MOCK_TAG_MOVED_STATE"' \
	'  exit "$status"' \
	'fi' \
	'if [[ "$1" == "release" && "$2" == "view" ]]; then' \
	'  if [[ -n "${MOCK_ASSET_STATE:-}" && -d "$MOCK_ASSET_STATE" ]]; then' \
	'    find "$MOCK_ASSET_STATE" -type f -exec basename {} \;' \
	'  fi' \
	'  exit 0' \
	'fi' \
	'if [[ "$1" == "release" && "$2" == "delete-asset" ]]; then' \
	'  delete_attempt=1' \
	'  if [[ -n "${MOCK_DELETE_STATE:-}" ]]; then' \
	'    [[ ! -f "$MOCK_DELETE_STATE" ]] || read -r delete_attempt < "$MOCK_DELETE_STATE"' \
	'    printf "%s\n" "$((delete_attempt + 1))" > "$MOCK_DELETE_STATE"' \
	'  fi' \
	'  if ((delete_attempt <= ${MOCK_DELETE_FAILURES:-0})); then exit 9; fi' \
	'  if [[ -n "${MOCK_ASSET_STATE:-}" ]]; then' \
	'    rm -f "$MOCK_ASSET_STATE/$4"' \
	'    rmdir "$MOCK_ASSET_STATE" 2>/dev/null || true' \
	'  fi' \
	'  exit 0' \
	'fi' \
	'exit 2' >"$verification_bin/gh"
chmod +x "$verification_bin/gh"
expected_release_sha="0123456789abcdef0123456789abcdef01234567"
GITHUB_REPOSITORY=marimo-team/marimohub MOCK_RELEASE_SHA="$expected_release_sha" \
	PATH="$verification_bin:$PATH" \
	"$repo_root/scripts/verify-release-tag.sh" v1.2.3 "$expected_release_sha"
if GITHUB_REPOSITORY=marimo-team/marimohub MOCK_RELEASE_SHA="${expected_release_sha%?}8" \
	PATH="$verification_bin:$PATH" \
	"$repo_root/scripts/verify-release-tag.sh" v1.2.3 "$expected_release_sha" >/dev/null 2>&1; then
	fail 'moved release tag was accepted'
fi

upload_asset="$temporary/mohub-test.tar.gz"
upload_log="$temporary/upload-gh.log"
touch "$upload_asset"
GITHUB_REPOSITORY=marimo-team/marimohub MOCK_RELEASE_SHA="$expected_release_sha" \
	MOCK_GH_LOG="$upload_log" PATH="$verification_bin:$PATH" \
	"$repo_root/scripts/upload-release-assets.sh" v1.2.3 "$expected_release_sha" "$upload_asset"
[[ "$(grep -c '^api ' "$upload_log")" == 2 ]] || fail 'upload did not validate before and after'
[[ "$(grep -c '^release upload ' "$upload_log")" == 1 ]] || fail 'asset was not uploaded once'

: >"$upload_log"
set +e
GITHUB_REPOSITORY=marimo-team/marimohub MOCK_RELEASE_SHA="$expected_release_sha" \
	MOCK_UPLOAD_EXIT=9 MOCK_GH_LOG="$upload_log" PATH="$verification_bin:$PATH" \
	"$repo_root/scripts/upload-release-assets.sh" \
	v1.2.3 "$expected_release_sha" "$upload_asset" >/dev/null 2>&1
failed_upload_status=$?
set -e
[[ "$failed_upload_status" == 9 ]] || fail 'failed release upload status was not preserved'
[[ "$(grep -c '^api ' "$upload_log")" == 2 ]] || fail 'failed upload skipped post-validation'
[[ "$(grep -c '^release upload ' "$upload_log")" == 1 ]] || fail 'failed upload count changed'

: >"$upload_log"
moved_tag_state="$temporary/moved-tag"
uploaded_asset_state="$temporary/uploaded-asset"
delete_state="$temporary/delete-attempts"
if GITHUB_REPOSITORY=marimo-team/marimohub MOCK_RELEASE_SHA="$expected_release_sha" \
	MOCK_MOVED_RELEASE_SHA="${expected_release_sha%?}8" \
	MOCK_TAG_MOVED_STATE="$moved_tag_state" MOCK_ASSET_STATE="$uploaded_asset_state" \
	MOCK_DELETE_STATE="$delete_state" MOCK_DELETE_FAILURES=1 RETRY_DELAY_SECONDS=0 \
	MOCK_GH_LOG="$upload_log" PATH="$verification_bin:$PATH" \
	"$repo_root/scripts/upload-release-assets.sh" \
	v1.2.3 "$expected_release_sha" "$upload_asset" >/dev/null 2>&1; then
	fail 'upload succeeded after the release tag moved'
fi
[[ ! -e "$uploaded_asset_state" ]] || fail 'asset remained attached after the release tag moved'
[[ "$(grep -c '^api ' "$upload_log")" == 2 ]] || fail 'moved tag was not validated after upload'
[[ "$(grep -c '^release upload ' "$upload_log")" == 1 ]] || fail 'moved-tag asset was not uploaded once'
[[ "$(grep -c "^release delete-asset v1.2.3 $(basename "$upload_asset") --yes$" "$upload_log")" == 2 ]] || \
	fail 'moved-tag asset cleanup was not retried'

: >"$upload_log"
rm -f "$moved_tag_state" "$delete_state"
partial_asset="$temporary/mohub-partial.zip"
touch "$partial_asset"
set +e
GITHUB_REPOSITORY=marimo-team/marimohub MOCK_RELEASE_SHA="$expected_release_sha" \
	MOCK_MOVED_RELEASE_SHA="${expected_release_sha%?}8" \
	MOCK_TAG_MOVED_STATE="$moved_tag_state" MOCK_ASSET_STATE="$uploaded_asset_state" \
	MOCK_UPLOAD_EXIT=9 MOCK_UPLOAD_LIMIT=1 RETRY_DELAY_SECONDS=0 \
	MOCK_GH_LOG="$upload_log" PATH="$verification_bin:$PATH" \
	"$repo_root/scripts/upload-release-assets.sh" v1.2.3 "$expected_release_sha" \
	"$upload_asset" "$partial_asset" >/dev/null 2>&1
partial_upload_status=$?
set -e
[[ "$partial_upload_status" == 9 ]] || fail 'partial upload status was not preserved'
[[ ! -e "$uploaded_asset_state" ]] || fail 'partial upload remained after the release tag moved'
[[ "$(grep -c '^api ' "$upload_log")" == 2 ]] || fail 'partial upload skipped post-validation'
[[ "$(grep -c '^release view ' "$upload_log")" == 1 ]] || fail 'partial upload assets were not listed'
[[ "$(grep -c '^release delete-asset ' "$upload_log")" == 1 ]] || \
	fail 'partial upload cleanup did not target only the attached asset'
grep -q "^release delete-asset v1.2.3 $(basename "$upload_asset") --yes$" "$upload_log" || \
	fail 'partially uploaded asset was not removed'

make_source "$temporary/success"
"$repo_root/scripts/stage-cli-release-assets.sh" \
	"$temporary/success" "$temporary/staged"
for archive in "${archives[@]}"; do
	[[ -f "$temporary/staged/$archive" ]] || fail "success case did not stage $archive"
done

make_source "$temporary/missing"
rm "$temporary/missing/artifacts/${archives[0]}.sha256"
if "$repo_root/scripts/stage-cli-release-assets.sh" \
	"$temporary/missing" "$temporary/missing-staged" >/dev/null 2>&1; then
	fail 'missing checksum was accepted'
fi

make_source "$temporary/mismatch"
printf '0%.0s' {1..64} >"$temporary/mismatch/artifacts/${archives[0]}.sha256"
if "$repo_root/scripts/stage-cli-release-assets.sh" \
	"$temporary/mismatch" "$temporary/mismatch-staged" >/dev/null 2>&1; then
	fail 'checksum mismatch was accepted'
fi

make_source "$temporary/duplicate"
mkdir -p "$temporary/duplicate/other"
cp "$temporary/duplicate/artifacts/${archives[0]}" "$temporary/duplicate/other/${archives[0]}"
if "$repo_root/scripts/stage-cli-release-assets.sh" \
	"$temporary/duplicate" "$temporary/duplicate-staged" >/dev/null 2>&1; then
	fail 'duplicate artifact basename was accepted'
fi

make_source "$temporary/existing"
mkdir "$temporary/existing-staged"
if "$repo_root/scripts/stage-cli-release-assets.sh" \
	"$temporary/existing" "$temporary/existing-staged" >/dev/null 2>&1; then
	fail 'pre-existing destination was accepted'
fi

retry_state="$temporary/retry-state"
RETRY_TEST_STATE="$retry_state" RETRY_ATTEMPTS=3 RETRY_DELAY_SECONDS=0 \
	"$repo_root/scripts/retry.sh" bash -c '
		count=0
		if [[ -f "$RETRY_TEST_STATE" ]]; then read -r count < "$RETRY_TEST_STATE"; fi
		count=$((count + 1))
		printf "%s\n" "$count" > "$RETRY_TEST_STATE"
		((count >= 3))
	'
read -r retry_count <"$retry_state"
[[ "$retry_count" == 3 ]] || fail "retry stopped after $retry_count attempts"

if RETRY_ATTEMPTS=2 RETRY_DELAY_SECONDS=0 \
	"$repo_root/scripts/retry.sh" false >/dev/null 2>&1; then
	fail 'retry exhaustion returned success'
fi
if RETRY_ATTEMPTS=0 "$repo_root/scripts/retry.sh" true >/dev/null 2>&1; then
	fail 'zero retry attempts were accepted'
fi
if RETRY_DELAY_SECONDS=-1 "$repo_root/scripts/retry.sh" true >/dev/null 2>&1; then
	fail 'negative retry delay was accepted'
fi

release_repo="$temporary/release-script"
mkdir -p "$release_repo/apps/cli" "$release_repo/docs" "$release_repo/scripts" "$release_repo/bin"
cp "$repo_root/scripts/release.mjs" "$release_repo/scripts/release.mjs"
printf '{"name":"release-test","version":"1.2.3"}\n' >"$release_repo/package.json"
printf '[package]\nname = "mohub"\nversion = "1.2.3"\n' >"$release_repo/apps/cli/Cargo.toml"
touch "$release_repo/apps/cli/Cargo.lock"
printf "setup:\n  version: '1.2.3'\n" >"$release_repo/docs/cli.md"
for command in git cargo gh; do
	printf '#!/usr/bin/env bash\nexit 0\n' >"$release_repo/bin/$command"
	chmod +x "$release_repo/bin/$command"
done
(
	cd "$release_repo"
	PATH="$release_repo/bin:$PATH" node scripts/release.mjs 1.2.4
)
grep -q '"version": "1.2.4"' "$release_repo/package.json" || fail 'package version was not updated'
grep -q 'version = "1.2.4"' "$release_repo/apps/cli/Cargo.toml" || fail 'Cargo version was not updated'
grep -q "version: '1.2.4'" "$release_repo/docs/cli.md" || fail 'CLI docs version was not updated'

echo 'release helper tests passed'
