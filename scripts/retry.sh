#!/usr/bin/env bash

set -u

attempts="${RETRY_ATTEMPTS:-4}"
delay="${RETRY_DELAY_SECONDS:-2}"

for ((attempt = 1; attempt <= attempts; attempt++)); do
	if "$@"; then
		exit 0
	fi
	if ((attempt == attempts)); then
		exit 1
	fi
	echo "Command failed on attempt $attempt; retrying in $delay seconds." >&2
	sleep "$delay"
	delay=$((delay * 2))
done
