# PDF Bucket — standalone PDF reading bucket: browser capture, PDF.js reader, send to Zotero.
#
# One Bun package: src/server (Hono), src/web (Vite + React), src/extension (WXT), tests/.
# desktop/ holds the Tauri crate; src/pdfbucket is the Python store and plugin package. QC
# delegates to the global ai-review-ci bun-python profile; bun, uv, wxt, vite and tauri are
# implementation details.

# ai-review-ci contract variables consumed by doctor and workflow installers.
ai_review_ci_schema_version := "1"
ai_review_ci_profile := "bun-python"
ai_review_ci_ref := "main"
ai_review_ci_release_channel := "main"
ai_review_ci_workflow_template_version := "1"
ai_review_ci_local_delegation := "global-justfile"
ai_review_ci_default_branch := "main"

# List available recipes.
default:
    @just --list

# Build every app: web bundle, both extension targets, desktop binary.
build: fetch-pdfjs
    @bun run build
    @cd desktop && bunx @tauri-apps/cli build

# Unpack the pinned prebuilt PDF.js viewer release into vendor/ (version and hash in pdf-bucket.config.json).
fetch-pdfjs:
    #!/usr/bin/env bash
    set -euo pipefail
    version=$(jq -r .pdfjs.version pdf-bucket.config.json)
    dest="vendor/pdfjs-$version"
    [[ -f "$dest/web/viewer.html" ]] && exit 0
    zip=$(mktemp --suffix=.zip)
    curl -fsSL -o "$zip" "https://github.com/mozilla/pdf.js/releases/download/v$version/pdfjs-$version-dist.zip"
    echo "$(jq -r .pdfjs.sha256 pdf-bucket.config.json)  $zip" | sha256sum --check --quiet
    mkdir -p "$dest"
    unzip -q "$zip" -d "$dest"
    trash "$zip"

# Build the library UI that the server serves at /.
build-web:
    @bunx vite build --config src/web/vite.config.ts

# Start the bucket server with hot reload on the configured host and port.
serve: fetch-pdfjs build-web
    @bun run dev

# Open the desktop window; Tauri starts the server first and waits for its URL.
run: fetch-pdfjs build-web
    #!/usr/bin/env bash
    set -euo pipefail
    url=$(jq -r '"http://\(.server.host):\(.server.port)"' pdf-bucket.config.json)
    cd desktop && bunx @tauri-apps/cli dev --config "{\"build\":{\"devUrl\":\"$url\"}}"

# Run commit-tier Python and Bun QC through the central implementation.
test-commit:
    @just -f ~/ai-review-ci/justfiles/python.just -d . test-commit
    @just -f ~/ai-review-ci/justfiles/bun.just -d . test-commit

# Run the full Python and Bun test suites before pushing.
test-push:
    @just -f ~/ai-review-ci/justfiles/python.just -d . test-push
    @just -f ~/ai-review-ci/justfiles/bun.just -d . test-push

# Run CI acceptance QC through both central implementations.
test-ci:
    @just -f ~/ai-review-ci/justfiles/python.just -d . test-ci
    @just -f ~/ai-review-ci/justfiles/bun.just -d . test-ci

# Seed empty, broken and 1,000-PDF bucket stores; screenshot every library state into docs/m2 (Chromium at
# 1600x1000, WebKitGTK on a headless 1400x900 display, the desktop window size) and print the load timings.
library-screenshots: fetch-pdfjs build-web
    @uv run --script scripts/library_screenshots.py docs/m2
