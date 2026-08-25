#!/usr/bin/env bash

set -euo pipefail

source_dir="${1:?source directory is required}"
destination_dir="${2:?destination directory is required}"

if [[ -e "$destination_dir" ]]; then
	echo "Destination already exists: $destination_dir" >&2
	exit 1
fi
mkdir -p "$destination_dir"

while IFS= read -r -d '' source_file; do
	filename="$(basename "$source_file")"
	destination_file="$destination_dir/$filename"
	if [[ -e "$destination_file" ]]; then
		echo "Duplicate CLI artifact filename: $filename" >&2
		exit 1
	fi
	cp "$source_file" "$destination_file"
done < <(find "$source_dir" -type f -print0)

expected_archives=(
	mohub-aarch64-apple-darwin.tar.gz
	mohub-aarch64-unknown-linux-gnu.tar.gz
	mohub-x86_64-apple-darwin.tar.gz
	mohub-x86_64-pc-windows-msvc.zip
	mohub-x86_64-unknown-linux-gnu.tar.gz
)

sha256_file() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk '{ print $1 }'
	else
		shasum -a 256 "$1" | awk '{ print $1 }'
	fi
}

for archive in "${expected_archives[@]}"; do
	if [[ ! -f "$destination_dir/$archive" ]]; then
		echo "Missing CLI archive: $archive" >&2
		exit 1
	fi
	if [[ ! -f "$destination_dir/$archive.sha256" ]]; then
		echo "Missing CLI checksum: $archive.sha256" >&2
		exit 1
	fi
	expected_checksum="$(awk 'NR == 1 { print $1 }' "$destination_dir/$archive.sha256")"
	if [[ ! "$expected_checksum" =~ ^[0-9a-fA-F]{64}$ ]]; then
		echo "Invalid CLI checksum: $archive.sha256" >&2
		exit 1
	fi
	actual_checksum="$(sha256_file "$destination_dir/$archive")"
	expected_checksum="$(printf '%s' "$expected_checksum" | tr '[:upper:]' '[:lower:]')"
	if [[ "$expected_checksum" != "$actual_checksum" ]]; then
		echo "CLI checksum mismatch: $archive" >&2
		exit 1
	fi
done
