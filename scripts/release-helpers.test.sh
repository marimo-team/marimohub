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

bash -n "$repo_root/scripts/publish-image-manifest.sh"
bash -n "$repo_root/scripts/release-tag.sh"
bash -n "$repo_root/scripts/retry.sh"
bash -n "$repo_root/scripts/stage-cli-release-assets.sh"
bash -n "$repo_root/scripts/upload-release-assets.sh"
bash -n "$repo_root/scripts/verify-release-tag.sh"

verification_bin="$temporary/verification-bin"
mkdir "$verification_bin"
printf '%s\n' \
	'#!/usr/bin/env bash' \
	'printf "%s\n" "$*" >> "${MOCK_GH_LOG:-/dev/null}"' \
	'if [[ "$1" == "api" && "$2" == repos/*/commits/* ]]; then' \
	'  verify_attempt=1' \
	'  if [[ -n "${MOCK_VERIFY_STATE:-}" ]]; then' \
	'    [[ ! -f "$MOCK_VERIFY_STATE" ]] || read -r verify_attempt < "$MOCK_VERIFY_STATE"' \
	'    printf "%s\n" "$((verify_attempt + 1))" > "$MOCK_VERIFY_STATE"' \
	'  fi' \
	'  if [[ "$verify_attempt" == "${MOCK_VERIFY_ERROR_CALL:-0}" ]]; then exit 8; fi' \
	'  if [[ -n "${MOCK_TAG_MOVED_STATE:-}" && -f "$MOCK_TAG_MOVED_STATE" ]]; then' \
	'    printf "%s\n" "$MOCK_MOVED_RELEASE_SHA"' \
	'  else' \
	'    printf "%s\n" "$MOCK_RELEASE_SHA"' \
	'  fi' \
	'  exit 0' \
	'fi' \
	'if [[ "$1" == "api" && "$2" == repos/*/releases/tags/* ]]; then' \
	'  printf "%s\n" "${MOCK_RELEASE_ID:-42}"' \
	'  exit 0' \
	'fi' \
	'if [[ "$1" == "api" && "$2" == "--paginate" ]]; then' \
	'  if [[ -n "${MOCK_ASSET_STATE:-}" && -d "$MOCK_ASSET_STATE" ]]; then' \
	'    for asset_record in "$MOCK_ASSET_STATE"/*; do' \
	'      [[ -f "$asset_record" ]] || continue' \
	'      printf "%s\t%s\n" "$(basename "$asset_record")" "$(<"$asset_record")"' \
	'    done' \
	'  fi' \
	'  if [[ "${MOCK_MOVE_AFTER_ASSET_LIST:-0}" == 1 && -n "${MOCK_TAG_MOVED_STATE:-}" ]]; then' \
	'    touch "$MOCK_TAG_MOVED_STATE"' \
	'  fi' \
	'  exit 0' \
	'fi' \
	'if [[ "$1" == "api" && "$2" == "--method" && "$3" == "DELETE" ]]; then' \
	'  delete_attempt=1' \
	'  if [[ -n "${MOCK_DELETE_STATE:-}" ]]; then' \
	'    [[ ! -f "$MOCK_DELETE_STATE" ]] || read -r delete_attempt < "$MOCK_DELETE_STATE"' \
	'    printf "%s\n" "$((delete_attempt + 1))" > "$MOCK_DELETE_STATE"' \
	'  fi' \
	'  if ((delete_attempt <= ${MOCK_DELETE_FAILURES:-0})); then exit 9; fi' \
	'  asset_id="${4##*/}"' \
	'  [[ -z "${MOCK_ASSET_STATE:-}" ]] || rm -f "$MOCK_ASSET_STATE/$asset_id"' \
	'  exit 0' \
	'fi' \
	'if [[ "$1" == "release" && "$2" == "upload" ]]; then' \
	'  status="${MOCK_UPLOAD_EXIT:-0}"' \
	'  uploaded=0' \
	'  for asset in "${@:4}"; do' \
	'    ((uploaded += 1))' \
	'    if ((uploaded > ${MOCK_UPLOAD_LIMIT:-999})); then break; fi' \
	'    if [[ -n "${MOCK_ASSET_STATE:-}" ]]; then' \
	'      mkdir -p "$MOCK_ASSET_STATE"' \
	'      asset_path="${asset%%#*}"' \
	'      digest_output=$(shasum -a 256 "$asset_path")' \
	'      digest="${digest_output%% *}"' \
	'      next_id=$(( $(find "$MOCK_ASSET_STATE" -type f | wc -l) + 1 ))' \
	'      printf "%s\tsha256:%s\n" "$(basename "$asset_path")" "$digest" > "$MOCK_ASSET_STATE/new-$next_id"' \
	'    fi' \
	'  done' \
	'  [[ -z "${MOCK_TAG_MOVED_STATE:-}" ]] || touch "$MOCK_TAG_MOVED_STATE"' \
	'  exit "$status"' \
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
set +e
GITHUB_REPOSITORY=marimo-team/marimohub MOCK_RELEASE_SHA="$expected_release_sha" \
	MOCK_VERIFY_ERROR_CALL=1 PATH="$verification_bin:$PATH" \
	"$repo_root/scripts/verify-release-tag.sh" v1.2.3 "$expected_release_sha" >/dev/null 2>&1
verification_error_status=$?
set -e
[[ "$verification_error_status" == 2 ]] || fail 'verification API error was not distinguished'

upload_asset="$temporary/mohub-test.tar.gz"
upload_log="$temporary/upload-gh.log"
touch "$upload_asset"
GITHUB_REPOSITORY=marimo-team/marimohub MOCK_RELEASE_SHA="$expected_release_sha" \
	MOCK_GH_LOG="$upload_log" PATH="$verification_bin:$PATH" \
	"$repo_root/scripts/upload-release-assets.sh" v1.2.3 "$expected_release_sha" "$upload_asset"
[[ "$(grep -c '^api repos/.*/commits/' "$upload_log")" == 2 ]] || \
	fail 'upload did not validate before and after'
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
[[ "$(grep -c '^api repos/.*/commits/' "$upload_log")" == 2 ]] || \
	fail 'failed upload skipped post-validation'
[[ "$(grep -c '^release upload ' "$upload_log")" == 1 ]] || fail 'failed upload count changed'

: >"$upload_log"
moved_tag_state="$temporary/moved-tag"
uploaded_asset_state="$temporary/uploaded-asset"
delete_state="$temporary/delete-attempts"
verify_state="$temporary/verify-attempts"
set +e
GITHUB_REPOSITORY=marimo-team/marimohub MOCK_RELEASE_SHA="$expected_release_sha" \
	MOCK_VERIFY_ERROR_CALL=2 MOCK_VERIFY_STATE="$verify_state" \
	MOCK_ASSET_STATE="$uploaded_asset_state" MOCK_GH_LOG="$upload_log" \
	PATH="$verification_bin:$PATH" \
	"$repo_root/scripts/upload-release-assets.sh" \
	v1.2.3 "$expected_release_sha" "$upload_asset" >/dev/null 2>&1
transient_verification_status=$?
set -e
[[ "$transient_verification_status" == 2 ]] || \
	fail 'transient post-upload verification error was not preserved'
[[ -f "$uploaded_asset_state/new-1" ]] || \
	fail 'transient verification error removed the uploaded asset'
[[ "$(grep -c '^api --method DELETE ' "$upload_log" || true)" == 0 ]] || \
	fail 'transient verification error triggered asset cleanup'

: >"$upload_log"
rm -rf "$uploaded_asset_state"
rm -f "$moved_tag_state" "$verify_state"
mkdir "$uploaded_asset_state"
printf '%s\tsha256:%s\n' "$(basename "$upload_asset")" \
	"$(sha256_file "$upload_asset")" >"$uploaded_asset_state/existing-77"
set +e
GITHUB_REPOSITORY=marimo-team/marimohub MOCK_RELEASE_SHA="$expected_release_sha" \
	MOCK_MOVED_RELEASE_SHA="${expected_release_sha%?}8" \
	MOCK_TAG_MOVED_STATE="$moved_tag_state" MOCK_MOVE_AFTER_ASSET_LIST=1 \
	MOCK_ASSET_STATE="$uploaded_asset_state" MOCK_GH_LOG="$upload_log" \
	PATH="$verification_bin:$PATH" \
	"$repo_root/scripts/upload-release-assets.sh" \
	v1.2.3 "$expected_release_sha" "$upload_asset" >/dev/null 2>&1
existing_asset_status=$?
set -e
[[ "$existing_asset_status" == 1 ]] || fail 'moved tag was accepted for an existing asset'
[[ -f "$uploaded_asset_state/existing-77" ]] || fail 'existing release asset was removed'
[[ "$(grep -c '^release upload ' "$upload_log" || true)" == 0 ]] || \
	fail 'existing release asset was uploaded again'
[[ "$(grep -c '^api --method DELETE ' "$upload_log" || true)" == 0 ]] || \
	fail 'existing release asset was selected for cleanup'

: >"$upload_log"
rm -f "$moved_tag_state"
printf '%s\tsha256:%064d\n' "$(basename "$upload_asset")" 0 \
	>"$uploaded_asset_state/existing-77"
if GITHUB_REPOSITORY=marimo-team/marimohub MOCK_RELEASE_SHA="$expected_release_sha" \
	MOCK_ASSET_STATE="$uploaded_asset_state" MOCK_GH_LOG="$upload_log" \
	PATH="$verification_bin:$PATH" \
	"$repo_root/scripts/upload-release-assets.sh" \
	v1.2.3 "$expected_release_sha" "$upload_asset" >/dev/null 2>&1; then
	fail 'existing release asset with different contents was accepted'
fi
[[ "$(grep -c '^release upload ' "$upload_log" || true)" == 0 ]] || \
	fail 'existing release asset with different contents was overwritten'

: >"$upload_log"
rm -rf "$uploaded_asset_state"
rm -f "$moved_tag_state" "$delete_state"
if GITHUB_REPOSITORY=marimo-team/marimohub MOCK_RELEASE_SHA="$expected_release_sha" \
	MOCK_MOVED_RELEASE_SHA="${expected_release_sha%?}8" \
	MOCK_TAG_MOVED_STATE="$moved_tag_state" MOCK_ASSET_STATE="$uploaded_asset_state" \
	MOCK_DELETE_STATE="$delete_state" MOCK_DELETE_FAILURES=1 RETRY_DELAY_SECONDS=0 \
	MOCK_GH_LOG="$upload_log" PATH="$verification_bin:$PATH" \
	"$repo_root/scripts/upload-release-assets.sh" \
	v1.2.3 "$expected_release_sha" "$upload_asset" >/dev/null 2>&1; then
	fail 'upload succeeded after the release tag moved'
fi
[[ -z "$(find "$uploaded_asset_state" -type f -print -quit)" ]] || \
	fail 'asset remained attached after the release tag moved'
[[ "$(grep -c '^api repos/.*/commits/' "$upload_log")" == 2 ]] || \
	fail 'moved tag was not validated after upload'
[[ "$(grep -c '^release upload ' "$upload_log")" == 1 ]] || fail 'moved-tag asset was not uploaded once'
[[ "$(grep -c '^api --method DELETE repos/.*/releases/assets/new-1$' "$upload_log")" == 2 ]] || \
	fail 'moved-tag asset cleanup was not retried'

: >"$upload_log"
rm -rf "$uploaded_asset_state"
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
[[ -z "$(find "$uploaded_asset_state" -type f -print -quit)" ]] || \
	fail 'partial upload remained after the release tag moved'
[[ "$(grep -c '^api repos/.*/commits/' "$upload_log")" == 2 ]] || \
	fail 'partial upload skipped post-validation'
[[ "$(grep -c '^api --paginate repos/.*/releases/42/assets ' "$upload_log")" == 2 ]] || \
	fail 'partial upload assets were not listed before and after upload'
[[ "$(grep -c '^api --method DELETE ' "$upload_log")" == 1 ]] || \
	fail 'partial upload cleanup did not target only the attached asset'
grep -q '^api --method DELETE repos/.*/releases/assets/new-1$' "$upload_log" || \
	fail 'partially uploaded asset was not removed'

: >"$upload_log"
rm -rf "$uploaded_asset_state"
rm -f "$moved_tag_state"
set +e
GITHUB_REPOSITORY=marimo-team/marimohub MOCK_RELEASE_SHA="$expected_release_sha" \
	MOCK_ASSET_STATE="$uploaded_asset_state" MOCK_UPLOAD_EXIT=9 MOCK_UPLOAD_LIMIT=1 \
	MOCK_GH_LOG="$upload_log" PATH="$verification_bin:$PATH" \
	"$repo_root/scripts/upload-release-assets.sh" v1.2.3 "$expected_release_sha" \
	"$upload_asset" "$partial_asset" >/dev/null 2>&1
resumable_upload_status=$?
set -e
[[ "$resumable_upload_status" == 9 ]] || fail 'resumable partial upload status changed'
[[ "$(find "$uploaded_asset_state" -type f | wc -l | tr -d ' ')" == 1 ]] || \
	fail 'resumable partial upload did not retain its completed asset'

: >"$upload_log"
GITHUB_REPOSITORY=marimo-team/marimohub MOCK_RELEASE_SHA="$expected_release_sha" \
	MOCK_ASSET_STATE="$uploaded_asset_state" MOCK_GH_LOG="$upload_log" \
	PATH="$verification_bin:$PATH" \
	"$repo_root/scripts/upload-release-assets.sh" v1.2.3 "$expected_release_sha" \
	"$upload_asset" "$partial_asset"
[[ "$(find "$uploaded_asset_state" -type f | wc -l | tr -d ' ')" == 2 ]] || \
	fail 'partial upload retry did not attach the missing asset'
grep -q "^release upload v1.2.3 $partial_asset$" "$upload_log" || \
	fail 'partial upload retry did not skip the existing asset'

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
printf '%s\n' \
	'#!/usr/bin/env bash' \
	'root="$(cd "$(dirname "$0")/.." && pwd)"' \
	'if [[ "$1" == "show" ]]; then' \
	'  case "$2" in' \
	'    origin/main:package.json) cat "$root/package.json" ;;' \
	'    origin/main:apps/cli/Cargo.toml) cat "$root/apps/cli/Cargo.toml" ;;' \
	'    origin/main:docs/cli.md) cat "$root/docs/cli.md" ;;' \
	'    *) exit 2 ;;' \
	'  esac' \
	'  exit 0' \
	'fi' \
	'[[ "$1" != "show-ref" ]]' >"$release_repo/bin/git"
chmod +x "$release_repo/bin/git"
for command in cargo gh; do
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

for tag in v1.2.3 v0.0.0 v10.20.30; do
	[[ "$("$repo_root/scripts/release-tag.sh" validate "$tag")" == "${tag#v}" ]] || \
		fail "stable release tag $tag was not accepted"
done
for tag in v1.2.3-rc.1 v1.2 v01.2.3 v1.02.3 1.2.3 v1.2.3.4 'v1.2.3 ' 'v1.2.3;id'; do
	if "$repo_root/scripts/release-tag.sh" validate "$tag" >/dev/null 2>&1; then
		fail "invalid release tag '$tag' was accepted"
	fi
done
if "$repo_root/scripts/release-tag.sh" floating v1.2.3-rc.1 </dev/null >/dev/null 2>&1; then
	fail 'latest was computed for a prerelease tag'
fi

floating() {
	printf '%s\n' "${@:2}" | "$repo_root/scripts/release-tag.sh" floating "$1" | tr '\n' ' '
}
[[ "$(floating v1.0.0)" == 'latest=true ' ]] || fail 'first release did not move latest'
[[ "$(floating v1.2.4 v1.2.3 v1.1.9 v0.9.0)" == 'latest=true ' ]] || \
	fail 'newest release did not move latest'
[[ "$(floating v1.2.3 v1.2.3 v1.2.2)" == 'latest=true ' ]] || \
	fail 'the release tag listing itself changed the result'
[[ "$(floating v1.2.4 v1.3.0 v1.2.3)" == 'latest=false ' ]] || fail 'patch backport moved latest'
[[ "$(floating v1.2.4 v1.2.5)" == 'latest=false ' ]] || fail 'an older patch moved latest'
[[ "$(floating v1.2.4 v1.3.0-rc.1 v2.0.0-rc.1 v1.2.3)" == 'latest=true ' ]] || \
	fail 'a prerelease tag outranked a stable release'
[[ "$(floating v1.9.0 v1.10.0)" == 'latest=false ' ]] || \
	fail 'release tags were not compared numerically'

amd64_digest="example/image@sha256:$(printf 'a%.0s' {1..64})"
arm64_digest="example/image@sha256:$(printf 'b%.0s' {1..64})"
manifest_bin="$temporary/manifest-bin"
mkdir "$manifest_bin"
cat >"$manifest_bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$MOCK_DOCKER_LOG"
case "$3" in
  create) exit "${MOCK_CREATE_EXIT:-0}" ;;
  inspect)
    if [[ "$4" == *@sha256:* ]]; then
      [[ "${MOCK_SOURCE_INSPECT_EXIT:-0}" == 0 ]] || exit "$MOCK_SOURCE_INSPECT_EXIT"
      case "$4" in
        *@sha256:a*) arch="${MOCK_AMD64_SOURCE_ARCH:-amd64}" ;;
        *) arch="${MOCK_ARM64_SOURCE_ARCH:-arm64}" ;;
      esac
      printf '{"manifests":[{"platform":{"os":"linux","architecture":"%s"}},{"platform":{"os":"unknown","architecture":"unknown"}}]}\n' "$arch"
      exit 0
    fi
    if [[ -n "${MOCK_INSPECT_STATE:-}" ]]; then
      inspect_attempt=1
      [[ ! -f "$MOCK_INSPECT_STATE" ]] || read -r inspect_attempt < "$MOCK_INSPECT_STATE"
      printf '%s\n' "$((inspect_attempt + 1))" > "$MOCK_INSPECT_STATE"
      if ((inspect_attempt <= ${MOCK_INSPECT_FAILURES:-0})); then exit 1; fi
    fi
    printf '%s\n' "$MOCK_MANIFEST"
    ;;
  *) exit 1 ;;
esac
MOCK
chmod +x "$manifest_bin/docker"
publish_manifest() {
	"$repo_root/scripts/publish-image-manifest.sh" "$amd64_digest" "$arm64_digest"
}
(
	export PATH="$manifest_bin:$PATH" MOCK_DOCKER_LOG="$temporary/docker.log" RETRY_DELAY_SECONDS=0
	export MOCK_MANIFEST='{"manifests":[{"platform":{"os":"linux","architecture":"arm64"}},{"platform":{"os":"unknown","architecture":"unknown"}},{"platform":{"os":"linux","architecture":"amd64"}}]}'
	printf 'example/image:latest\nexample/image:1.0.0' | publish_manifest >/dev/null
	expected_log="buildx imagetools inspect $amd64_digest --raw
buildx imagetools inspect $arm64_digest --raw
buildx imagetools create --tag example/image:latest --tag example/image:1.0.0 $amd64_digest $arm64_digest
buildx imagetools inspect example/image:latest --raw"
	[[ "$(<"$MOCK_DOCKER_LOG")" == "$expected_log" ]] || \
		fail 'manifest sources were not inspected before create, or tags or sources differ'

	: >"$MOCK_DOCKER_LOG"
	if publish_manifest </dev/null >/dev/null 2>&1; then
		fail 'empty destination tags were accepted'
	fi
	[[ ! -s "$MOCK_DOCKER_LOG" ]] || fail 'empty tags triggered Docker'

	if "$repo_root/scripts/publish-image-manifest.sh" example/image:sha-123-amd64 \
		<<<'example/image:latest' >/dev/null 2>&1; then
		fail 'a mutable source tag was accepted'
	fi
	[[ ! -s "$MOCK_DOCKER_LOG" ]] || fail 'a mutable source tag triggered Docker'

	export MOCK_SOURCE_INSPECT_EXIT=1 RETRY_ATTEMPTS=2
	if publish_manifest <<<'example/image:latest' >/dev/null 2>&1; then
		fail 'a missing source image was accepted'
	fi
	! grep -q ' create ' "$MOCK_DOCKER_LOG" || fail 'a missing source image still moved tags'
	unset MOCK_SOURCE_INSPECT_EXIT RETRY_ATTEMPTS

	: >"$MOCK_DOCKER_LOG"
	export MOCK_ARM64_SOURCE_ARCH=amd64
	if publish_manifest <<<'example/image:latest' >/dev/null 2>&1; then
		fail 'a source set missing arm64 was accepted'
	fi
	[[ "$(grep -c ' inspect .*@sha256:.* --raw$' "$MOCK_DOCKER_LOG")" == 2 ]] || \
		fail 'source platforms were not inspected'
	! grep -q ' create ' "$MOCK_DOCKER_LOG" || fail 'a source set missing arm64 still moved tags'
	unset MOCK_ARM64_SOURCE_ARCH

	: >"$MOCK_DOCKER_LOG"
	publish_manifest <<<'example/image:latest' >/dev/null || fail 'a complete source set was rejected'
	[[ "$(grep -c ' create ' "$MOCK_DOCKER_LOG")" == 1 ]] || fail 'a complete source set did not create'

	: >"$MOCK_DOCKER_LOG"
	export MOCK_CREATE_EXIT=1 RETRY_ATTEMPTS=2
	if publish_manifest <<<'example/image:latest' >/dev/null 2>&1; then
		fail 'failed manifest creation was accepted'
	fi
	[[ "$(grep -c ' create ' "$MOCK_DOCKER_LOG")" == 2 ]] || fail 'manifest creation was not retried'
	unset MOCK_CREATE_EXIT RETRY_ATTEMPTS

	export MOCK_INSPECT_STATE="$temporary/inspect-attempts" MOCK_INSPECT_FAILURES=1
	publish_manifest <<<'example/image:latest' >/dev/null 2>&1 || \
		fail 'a transient destination inspect failure was not retried'
	rm -f "$MOCK_INSPECT_STATE"
	export MOCK_INSPECT_FAILURES=99 RETRY_ATTEMPTS=2
	if publish_manifest <<<'example/image:latest' >/dev/null 2>&1; then
		fail 'a failed destination inspect was accepted'
	fi
	unset MOCK_INSPECT_STATE MOCK_INSPECT_FAILURES RETRY_ATTEMPTS

	export MOCK_MANIFEST='<html>502 Bad Gateway</html>'
	if publish_manifest <<<'example/image:latest' >/dev/null 2>&1; then
		fail 'non-JSON inspect output was accepted'
	fi

	export MOCK_MANIFEST='{"manifests":[{"platform":{"os":"linux","architecture":"amd64"}},{"platform":{"os":"linux","architecture":"arm64","variant":"v8"}}]}'
	publish_manifest <<<'example/image:latest' >/dev/null || fail 'an arm64/v8 entry was rejected'

	for arch in amd64 arm64; do
		export MOCK_MANIFEST="{\"manifests\":[{\"platform\":{\"os\":\"linux\",\"architecture\":\"$arch\"}}]}"
		if publish_manifest <<<'example/image:latest' >/dev/null 2>&1; then
			fail "single-architecture manifest ($arch) was accepted"
		fi
	done
)

echo 'release helper tests passed'
