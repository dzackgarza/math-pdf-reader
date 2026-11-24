#!/bin/sh
# Hold one completed extraction until the test replaces its input paper.
set -eu
pdf=$1
output=$2
root=$(dirname "$(dirname "$pdf")")
printf 'started\n' >"$root/extraction-started"
attempt=0
while [ ! -e "$root/extraction-release" ]; do
	attempt=$((attempt + 1))
	if [ "$attempt" -ge 1200 ]; then
		exit 1
	fi
	sleep 0.05
done
printf '# From the previous paper\n' >"$output/extraction.md"
