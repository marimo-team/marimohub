#!/bin/sh
# Idempotent: creates the demo namespace and an empty events table (409 = exists).
set -eu

base="http://iceberg-rest:8181/v1"

i=0
until curl -fsS --max-time 3 "$base/config" >/dev/null 2>&1; do
	i=$((i + 1))
	if [ "$i" -ge 60 ]; then
		echo 'Iceberg REST catalog did not become ready' >&2
		exit 1
	fi
	sleep 1
done

status=$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' -X POST "$base/namespaces" \
	-H 'Content-Type: application/json' -d '{"namespace":["demo"]}')
case "$status" in
200 | 409) ;;
*)
	echo "Creating the demo namespace failed with HTTP $status" >&2
	exit 1
	;;
esac

status=$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' -X POST "$base/namespaces/demo/tables" \
	-H 'Content-Type: application/json' -d @/seed/data/events-table.json)
case "$status" in
200 | 409) ;;
*)
	echo "Creating demo.events failed with HTTP $status" >&2
	exit 1
	;;
esac
