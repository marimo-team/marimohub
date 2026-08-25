#!/usr/bin/env bash

set -u

attempts="${RETRY_ATTEMPTS:-4}"
delay="${RETRY_DELAY_SECONDS:-2}"

if [[ ! "$attempts" =~ ^[1-9][0-9]*$ ]]; then
	echo "RETRY_ATTEMPTS must be a positive integer." >&2
	exit 2
fi
if [[ ! "$delay" =~ ^[0-9]+$ ]]; then
	echo "RETRY_DELAY_SECONDS must be a non-negative integer." >&2
	exit 2
fi

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
