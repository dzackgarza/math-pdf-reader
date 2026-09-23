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

# Build every app into dist/: web bundle, Chrome and Firefox extensions (and the Firefox
# package), desktop binary and its bundles.
build: fetch-pdfjs
    @bun run build
    @cd desktop && bunx @tauri-apps/cli build

# Build what the running bucket needs (web bundle, PDF.js viewer, desktop binary), then install
# and enable the systemd user units rendered for this checkout: the server at login, the window
# with the graphical session, and the hourly index export. Starts the server and the window.
provision: fetch-pdfjs
    #!/usr/bin/env bash
    set -euo pipefail
    repo="{{justfile_directory()}}"
    # The server unit loads the provider keys through direnv; a blocked .envrc fails here.
    direnv exec "$repo" true
    bun install --frozen-lockfile
    uv sync --locked
    bunx vite build --config src/web/vite.config.ts
    (cd desktop && bunx @tauri-apps/cli build --no-bundle)
    units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    origin=$(jq -r '"http://\(.server.host):\(.server.port)"' pdf-bucket.config.json)
    bun=$(which bun)
    uv=$(which uv)
    direnv=$(which direnv)
    path="$(dirname "$bun"):$(dirname "$uv"):/usr/local/bin:/usr/bin"
    mkdir -p "$units"
    for template in systemd/*; do
        sed -e "s|@REPO@|$repo|g" -e "s|@BUN@|$bun|g" -e "s|@DIRENV@|$direnv|g" \
            -e "s|@ORIGIN@|$origin|g" -e "s|@PATH@|$path|g" "$template" > "$units/$(basename "$template")"
    done
    systemd-analyze --user verify "$units"/pdf-bucket.service "$units"/pdf-bucket-window.service \
        "$units"/pdf-bucket-export.service "$units"/pdf-bucket-export.timer
    systemctl --user daemon-reload
    systemctl --user enable pdf-bucket.service pdf-bucket-window.service pdf-bucket-export.timer
    systemctl --user restart pdf-bucket.service pdf-bucket-window.service pdf-bucket-export.timer
    systemctl --user --no-pager status pdf-bucket.service pdf-bucket-window.service pdf-bucket-export.timer

# Write the index export ($XDG_DATA_HOME/pdf-bucket-export/index.json): every stored item's
# provenance and filing, and the collections and saved searches. Refuses to drop an item whose
# PDF is missing.
export-index:
    @bun run src/server/indexCli.ts export

# Restore the filing (collections, tags, notes, saved searches) from an index export into a data
# root that has none.
import-index file="":
    @bun run src/server/indexCli.ts import {{file}}

# Re-download every PDF the index export lists and the data root lacks, into the same key; prints
# each item's outcome and fails when a URL is dead or now serves different bytes.
rebuild-cache:
    @bun run src/server/indexCli.ts rebuild

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

# Drive both built capture extensions (chromium and firefox on PATH) against the fixture site; screenshots land in $TMPDIR/pdf-bucket-capture-e2e.
test-capture:
    @bun test tests/capture-e2e.test.ts

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

# Run the full Python and Bun test suites and the desktop crate's Rust checks before pushing.
test-push:
    @just -f ~/ai-review-ci/justfiles/python.just -d . test-push
    @just -f ~/ai-review-ci/justfiles/bun.just -d . test-push
    @just desktop-rust-checks

# Run CI acceptance QC through the Python, Bun and Rust central implementations.
test-ci:
    @just -f ~/ai-review-ci/justfiles/python.just -d . test-ci
    @just -f ~/ai-review-ci/justfiles/bun.just -d . test-ci
    @just desktop-rust-checks

# rustfmt check and clippy with warnings denied on the Tauri crate, from the central Rust implementation.
desktop-rust-checks:
    @just -f ~/ai-review-ci/justfiles/rust.just -d . _rustfmt
    @just -f ~/ai-review-ci/justfiles/rust.just -d . _clippy

# Provision the CI runner: Tauri's Linux build inputs, and user namespaces for Chromium's
# sandbox, which Ubuntu 24.04's AppArmor blocks (actions/runner-images#10443). The qc-ci job
# runs this recipe as its setup_recipe.
ci-setup:
    sudo apt-get update
    sudo apt-get install -y libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
    sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0

# Run a shipped extraction plugin with its real provider on a fixture PDF stored in a fresh root; print the outcome.
extraction-evidence plugin fixture="tests/fixtures/ten-page-notes.pdf":
    #!/usr/bin/env bash
    set -euo pipefail
    root=$(mktemp -d --suffix=-pdf-bucket-evidence)
    key=$(basename "{{fixture}}" .pdf)
    uv run --locked pdfbucket capture "$root" "{{fixture}}" "$key.pdf" \
        "https://www.math.example.edu/~author/$key.pdf" "https://www.math.example.edu/~author/teaching.html" "$key" >/dev/null
    echo "root: $root"
    uv run --locked pdfbucket extract "$root" "$key" plugins/manifests/extractions.json "{{plugin}}"

# Seed empty, broken and 1,000-PDF bucket stores; screenshot every library state into docs/m2 (Chromium at
# 1600x1000, WebKitGTK on a headless 1400x900 display, the desktop window size) and print the load timings.
library-screenshots: fetch-pdfjs build-web
    @uv run --script scripts/library_screenshots.py docs/m2

# Export, wipe, import and rebuild a temporary store through the recipes above, then delete three
# PDFs (one at a URL the fixture publisher has taken down) and rebuild again; prints the transcript.
cache-evidence:
    @bun tests/cache-evidence.ts
