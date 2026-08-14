#!/bin/sh
# Idempotent: creates the dev buckets, copies the sample objects, and generates
# stress fixtures (a prefix with many small objects to exercise list
# pagination, plus large objects to exercise preview/download byte limits).
set -eu

mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc mb --ignore-existing local/dev-data
mc mb --ignore-existing local/warehouse
mc cp /seed/data/reports.csv local/dev-data/samples/reports.csv
mc cp /seed/data/events.jsonl local/dev-data/samples/events.jsonl

# The marker is uploaded only after the mirror succeeds, so an interrupted run
# regenerates on the next attempt instead of leaving a partial fixture behind.
if ! mc stat local/dev-data/stress/.complete >/dev/null 2>&1; then
	stress=/tmp/stress
	mkdir -p "$stress/many" "$stress/large"

	for i in $(seq 0 1999); do
		printf 'id,value\n%s,%s\n' "$i" "$((i * 7))" >"$stress/many/part-$(printf '%05d' "$i").csv"
	done

	# ~256k rows (~6 MiB) by doubling a 1000-row chunk; row ids repeat, which is
	# fine for size stress.
	chunk=/tmp/chunk.csv
	: >"$chunk"
	for i in $(seq 0 999); do
		printf '%s,row-%s,%s.5\n' "$i" "$i" "$((i * 3))" >>"$chunk"
	done
	printf 'id,name,value\n' >"$stress/large/wide.csv"
	for _ in 1 2 3 4 5 6 7 8; do
		cat "$chunk" "$chunk" >"$chunk.next" && mv "$chunk.next" "$chunk"
	done
	cat "$chunk" >>"$stress/large/wide.csv"
	rm -f "$chunk"

	dd if=/dev/urandom of="$stress/large/blob-64mib.bin" bs=1048576 count=64 2>/dev/null

	mc mirror --overwrite "$stress" local/dev-data/stress
	printf 'seeded\n' | mc pipe local/dev-data/stress/.complete
	rm -rf "$stress"
fi
