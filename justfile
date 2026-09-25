# PDF Bucket — standalone PDF reading bucket: browser capture, PDF.js reader, send to Zotero.
#
# One Cargo workspace: server/ is the bucket server (axum), desktop/src-tauri the Tauri app that
# runs it in its own process. One Bun package: src/contract (the zod contracts the server's types
# are generated from), src/web (Vite + React), src/extension (WXT), tests/. src/pdfbucket holds the
# pikepdf commands the server runs on stored PDFs, src/pdfbucket_extractors the extraction
# plugins. QC delegates to the global ai-review-ci bun-python profile;
# cargo, bun, uv, wxt, vite and tauri are implementation details.

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
# NO_STRIP: linuxdeploy's bundled strip cannot read the `.relr.dyn` sections of current distro
# libraries and fails the AppImage (tauri-apps/tauri#8929; Tauri's AppImage guide).
build: fetch-pdfjs
    @bun run build
    @cd desktop && NO_STRIP=true bunx @tauri-apps/cli build

# Build the web bundle, the PDF.js viewer and the release app; install the app with its launcher
# and login autostart entry (pdf-bucket-desktop.desktop) and icons, and start it. The app is the
# bucket server; it serves this checkout's PDF.js viewer and library bundle and runs its store
# and plugins.
provision: fetch-pdfjs
    @scripts/provision.sh

# Write the index export ($XDG_DATA_HOME/pdf-bucket-export/index.json): every stored item's
# provenance, filing and extraction record, and the collections, saved searches and reading
# sessions. Refuses to drop an item whose PDF is missing and that was not deleted, sent or
# forgotten.
export-index:
    @uv sync --locked --quiet
    @cargo run --quiet --package pdf-bucket --bin pdf-bucket -- export-index

# Restore the filing (collections, tags, notes, saved searches) and the reading sessions from an
# index export into a data root whose filing holds nothing yet.
import-index file="":
    @cargo run --quiet --package pdf-bucket --bin pdf-bucket -- import-index {{file}}

# Forget an item the index export lists whose PDF is gone for good: drop its filing and write the
# export without it.
forget key file="":
    @cargo run --quiet --package pdf-bucket --bin pdf-bucket -- forget {{key}} {{file}}

# Re-download every PDF the index export lists and the data root lacks, into the same key; prints
# each item's outcome and fails when a URL is dead or now serves different bytes.
rebuild-cache:
    @uv sync --locked --quiet
    @cargo run --quiet --package pdf-bucket --bin pdf-bucket -- rebuild-cache

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

# Sign the Firefox build with addons.mozilla.org as an unlisted (self-distributed) add-on, so a
# normal Firefox installs it; the signed .xpi lands in dist/firefox-signed. The build is
# minified, so the committed source goes with it (AMO's source-code policy). AMO signs each
# version once: raise `version` in package.json before signing a changed build. Credentials
# are MOZILLA_JWT_ISSUER and MOZILLA_JWT_SECRET from the environment direnv loads here.
sign-firefox:
    #!/usr/bin/env bash
    set -euo pipefail
    bunx wxt build -b firefox
    mkdir -p dist/firefox-signed
    git archive --format=zip -o dist/firefox-signed/pdf-bucket-source.zip HEAD
    signed=$(mktemp -d)
    direnv exec . bash -c 'WEB_EXT_API_KEY="$MOZILLA_JWT_ISSUER" WEB_EXT_API_SECRET="$MOZILLA_JWT_SECRET" bunx web-ext sign --channel unlisted --source-dir dist/firefox-mv2 --artifacts-dir "$0" --upload-source-code dist/firefox-signed/pdf-bucket-source.zip' "$signed"
    # web-ext names the file after a hash of the add-on id; the package keeps the version.
    mv "$signed"/*.xpi "dist/firefox-signed/pdf-bucket-$(jq -r .version package.json)-firefox.xpi"

# Drive both built capture extensions (chromium and firefox on PATH) against the fixture site; screenshots land in $TMPDIR/pdf-bucket-capture-e2e.
test-capture:
    @bun test tests/capture-e2e.test.ts

# Open the desktop app from source (`tauri dev`); it serves the configured bucket itself.
run: fetch-pdfjs build-web
    @cd desktop && bunx @tauri-apps/cli dev

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

# rustfmt check, clippy with warnings denied, and cargo test on the server and desktop crates,
# from the central Rust implementation.
desktop-rust-checks:
    @just -f ~/ai-review-ci/justfiles/rust.just -d . _rustfmt
    @just -f ~/ai-review-ci/justfiles/rust.just -d . _clippy
    @just -f ~/ai-review-ci/justfiles/rust.just -d . _cargo-test

# Provision the CI runner: Tauri's Linux build inputs, user namespaces for Chromium's sandbox,
# which Ubuntu 24.04's AppArmor blocks (actions/runner-images#10443), and the pinned PDF.js viewer
# the reader pages load (trash-cli for the recipe's cleanup). The qc-ci job runs this recipe as
# its setup_recipe.
ci-setup:
    sudo apt-get update
    sudo apt-get install -y libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev trash-cli
    sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
    just fetch-pdfjs

# Run a shipped extraction plugin with its real provider on a fixture PDF stored in a fresh root; print the outcome.
extraction-evidence plugin fixture="tests/fixtures/ten-page-notes.pdf":
    #!/usr/bin/env bash
    set -euo pipefail
    uv sync --locked --quiet
    cargo build --quiet --package pdf-bucket --bin pdf-bucket
    root=$(mktemp -d --suffix=-pdf-bucket-evidence)
    key=$(basename "{{fixture}}" .pdf)
    # The server serves until its standard input, this script's coprocess pipe, closes.
    coproc server { target/debug/pdf-bucket serve "$root" "$(jq -r .zotero.url pdf-bucket.config.json)" plugins/manifests/extractions.json plugins/manifests/resolvers.json; }
    read -r origin <&"${server[0]}"
    curl --fail-with-body --silent --show-error -o /dev/null \
        -F "pdf=@{{fixture}};filename=$key.pdf;type=application/pdf" \
        -F "pdf_url=https://www.math.example.edu/~author/$key.pdf" \
        -F "source_url=https://www.math.example.edu/~author/teaching.html" \
        -F "title_hint=$key" "$origin/capture-bytes"
    echo "root: $root"
    curl --silent --show-error -X POST "$origin/api/items/$key/extractions/{{plugin}}"

# Seed empty, broken and 1,000-PDF bucket stores; screenshot every library state into docs/m2 (Chromium at
# 1600x1000, WebKitGTK on a headless 1400x900 display, the desktop window size) and print the load timings.
library-screenshots: fetch-pdfjs build-web
    @uv run --script scripts/library_screenshots.py docs/m2

# Screenshot the send action's states (idle, sending, failed, sent, refused, remove) into docs/m3
# against a two-item bucket whose Zotero is a closed port, so nothing reaches a real library.
send-screenshots: fetch-pdfjs build-web
    @uv run --script scripts/library_screenshots.py send docs/m3

# Screenshot the inspector's extraction runs (idle, running, succeeded, failed, rejected) into
# docs/m4 against the committed fixture extractor, so no provider is called.
extract-screenshots: fetch-pdfjs build-web
    @uv run --script scripts/library_screenshots.py extract docs/m4

# Export, wipe, import and rebuild a temporary store through the recipes above, then delete three
# PDFs (one at a URL the fixture publisher has taken down) and rebuild again; prints the transcript.
cache-evidence:
    @bun run cache-evidence
