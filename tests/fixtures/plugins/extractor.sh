#!/bin/sh
# Extraction plugin for runner tests: `extractor.sh MODE PDF OUTPUT`.
#   record    Markdown = its own arguments, one per line; artifacts/source.pdf = the PDF.
#   markdown  Markdown only.
#   misnamed  Markdown under the PDF's own name instead of extraction.md.
#   fail      partial Markdown and artifacts, a message on stderr, exit 3.
set -eu
mode=$1
pdf=$2
output=$3
case "$mode" in
record)
	printf '%s\n' "$@" >"$output/extraction.md"
	mkdir "$output/artifacts"
	cp "$pdf" "$output/artifacts/source.pdf"
	;;
markdown)
	printf '# Extracted by the markdown mode\n' >"$output/extraction.md"
	;;
misnamed)
	printf '# Extracted\n' >"$output/$(basename "$pdf" .pdf).md"
	;;
fail)
	printf '# partial\n' >"$output/extraction.md"
	mkdir "$output/artifacts"
	printf 'provider quota exhausted for this token\n' >&2
	exit 3
	;;
esac
