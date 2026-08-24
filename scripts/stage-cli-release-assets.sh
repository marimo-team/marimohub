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

for archive in "${expected_archives[@]}"; do
	if [[ ! -f "$destination_dir/$archive" ]]; then
		echo "Missing CLI archive: $archive" >&2
		exit 1
	fi
	if [[ ! -f "$destination_dir/$archive.sha256" ]]; then
		echo "Missing CLI checksum: $archive.sha256" >&2
		exit 1
	fi
done
