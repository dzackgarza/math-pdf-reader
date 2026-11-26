ai_review_ci_schema_version := "1"
ai_review_ci_profile := "bun-python"
ai_review_ci_ref := "main"
ai_review_ci_release_channel := "main"
ai_review_ci_workflow_template_version := "1"
ai_review_ci_local_delegation := "global-justfile"
ai_review_ci_default_branch := "main"

[doc("List available recipes.")]
default:
    @just --list

[doc("Build the web bundle and desktop binary into dist/ and target/. The private `_provision-extensions` recipe builds the browser extensions.")]
build:
    @bun run build
    @cd desktop && NO_STRIP=true bunx @tauri-apps/cli build

[doc("Build the web bundle and the release app; install the app with its launcher, login autostart entry (pdf-bucket-desktop.desktop) and icons, and start it. The app is the bucket server and runs against its own copy of the runtime files ($XDG_DATA_HOME/pdf-bucket-app), so later changes to the checkout reach it only through the next provision.")]
provision:
    @scripts/provision.sh

[doc("What scripts/launch runs when the source changed since the last provision: the same build and install, with no start of the app, which the launch itself starts.")]
provision-for-launch:
    @scripts/provision.sh --for-launch

[private]
_provision-extensions:
    @scripts/provision-extensions.sh

[doc("Write the index export ($XDG_DATA_HOME/pdf-bucket-export/index.json): every stored item's provenance, filing and extraction record, and the collections, saved searches and reading sessions. Refuses to drop an item whose PDF is missing and that was not deleted, sent or forgotten.")]
export-index:
    @uv sync --locked --quiet
    @cargo run --quiet --package pdf-bucket --bin pdf-bucket -- export-index

[doc("Restore the filing (collections, tags, notes, saved searches) and the reading sessions from an index export into a data root whose filing holds nothing yet.")]
import-index file="":
    @cargo run --quiet --package pdf-bucket --bin pdf-bucket -- import-index {{file}}

[doc("Forget an item the index export lists whose PDF is gone for good: drop its filing and write the export without it.")]
forget key file="":
    @cargo run --quiet --package pdf-bucket --bin pdf-bucket -- forget {{key}} {{file}}

[doc("Re-download every PDF the index export lists and the data root lacks, into the same key; prints each item's outcome and fails when a URL is dead or now serves different bytes.")]
rebuild-cache:
    @uv sync --locked --quiet
    @cargo run --quiet --package pdf-bucket --bin pdf-bucket -- rebuild-cache

[doc("Build the web bundle the server serves: the library at / and the reader of /read/<key>.")]
build-web:
    @bunx vite build --config src/web/vite.config.ts

[doc("Merge the Firefox enterprise policy through which Firefox installs and updates the capture add-on from the bucket (scripts/firefox-policy.sh) into /etc/firefox/policies/policies.json, keeping the policies already there. Needs sudo, once; Firefox reads it at its next start. The private `_provision-extensions` recipe refuses to run without it.")]
[script("bash")]
firefox-policy:
    set -euo pipefail
    file=/etc/firefox/policies/policies.json
    have=$(if [[ -f "$file" ]]; then cat "$file"; else echo '{}'; fi)
    sudo install -d -m 755 "$(dirname "$file")"
    jq -n --argjson have "$have" --argjson ours "$(scripts/firefox-policy.sh)" '$have * $ours' \
        | sudo tee "$file" > /dev/null

[doc("Drive both built capture extensions (chromium and firefox on PATH) against the fixture site; screenshots land in $TMPDIR/pdf-bucket-capture-e2e.")]
test-capture:
    @bun test tests/capture-e2e.test.ts

[doc("Run the mutating Zotero integration suite against the real local Zotero write API.")]
test-zotero-live:
    @ZOTERO_LIVE=1 bun test ./tests/server-send-live.ts --timeout 180000

[doc("Verify the configured assistant can inspect a PDF and read newly added Markdown with its shell, in a private app and assistant server; the configured provider must be reachable.")]
test-assistant-live:
    @bun test ./tests/server-ai-live.ts --timeout 660000

[doc("Open the desktop app from source (`tauri dev`); it serves the configured bucket itself.")]
run: build-web
    @cd desktop && bunx @tauri-apps/cli dev

[doc("Build the release app and drive one reading session through its window (tests/desktop_workflow.py): WebKitWebDriver on a headless Weston, in a private network namespace and D-Bus session, so the app takes its fixed port and single-instance name beside the provisioned one.")]
test-desktop: build-web
    @cd desktop && bunx @tauri-apps/cli build --no-bundle
    @uv sync --locked --quiet
    @unshare -rn sh -c 'ip link set lo up && exec dbus-run-session -- uv run pytest tests/desktop_workflow.py'

[doc("Fail when code under src, server, desktop, plugins or scripts names a prior repo (mathread, zotero-gui, zotero-library, zotero-library-tools).")]
check-prior-repo-names:
    @! grep -rnIE 'mathread|zotero-gui|zotero_gui|zotero-library|zotero_library' src server desktop plugins scripts --exclude-dir=node_modules --exclude-dir=target --exclude-dir=.venv || { echo 'code names a prior repo; AGENTS.md Reuse policy allows those names only in commit messages' >&2; exit 1; }

[doc("Run commit-tier Python and Bun QC through the central implementation.")]
test-commit:
    @bun run typecheck
    @just check-prior-repo-names
    @bun run build
    @just -f ~/ai-review-ci/justfiles/bun-python.just -d . test-commit

[doc("Run the full Python and Bun test suites before pushing.")]
test-push:
    @just -f ~/ai-review-ci/justfiles/bun-python.just -d . test-push

[doc("Run CI acceptance QC through the central bun-python and Rust implementations, and the desktop workflow through the release app. CI runs it on every pull request and every push to main.")]
test-ci:
    @just -f ~/ai-review-ci/justfiles/bun-python.just -d . test-ci
    @just desktop-rust-checks
    @just test-desktop

[doc("rustfmt check, clippy with warnings denied, and cargo test on the server and desktop crates, from the central Rust implementation.")]
desktop-rust-checks:
    @just -f ~/ai-review-ci/justfiles/rust.just -d . _rustfmt
    @just -f ~/ai-review-ci/justfiles/rust.just -d . _clippy
    @just -f ~/ai-review-ci/justfiles/rust.just -d . _cargo-test

[doc("Provision the CI runner: Tauri's Linux build inputs, user namespaces for Chromium's sandbox and the desktop workflow's private network, which Ubuntu 24.04's AppArmor blocks (actions/runner-images issue 10443), Weston, WebKitWebDriver and at-spi2-core (the AT-SPI bus a dialog test reads) for the desktop workflow, direnv with the checkout's `.envrc` allowed (the app reads the plugins' environment through it), and a session bus for later steps: without one, Chromium's start retries the bus for seconds and can miss Puppeteer's 30 s launch limit. The qc jobs run this recipe as their setup_recipe.")]
ci-setup:
    sudo apt-get update
    sudo apt-get install -y pandoc texlive-extra-utils libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev weston webkitgtk-webdriver at-spi2-core direnv
    sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
    direnv allow .
    echo "DBUS_SESSION_BUS_ADDRESS=$(dbus-daemon --session --fork --print-address)" >> "$GITHUB_ENV"

[doc("Run a shipped extraction plugin with its real provider on a fixture PDF stored in a fresh root; print the outcome. The server serves until its standard input, the recipe's coprocess pipe, closes.")]
[script("bash")]
extraction-evidence plugin fixture="tests/fixtures/ten-page-notes.pdf":
    set -euo pipefail
    uv sync --locked --quiet
    cargo build --quiet --package pdf-bucket --bin pdf-bucket
    root=$(mktemp -d --suffix=-pdf-bucket-evidence)
    key=$(basename "{{fixture}}" .pdf)
    coproc server { target/debug/pdf-bucket serve "$root" "$(jq -r .zotero.url pdf-bucket.config.json)" plugins/manifests/extractions.json --index-export "$root-export/index.json" --config pdf-bucket.config.json; }
    read -r origin <&"${server[0]}"
    curl --fail-with-body --silent --show-error -o /dev/null \
        -F "pdf=@{{fixture}};filename=$key.pdf;type=application/pdf" \
        -F "pdf_url=https://www.math.example.edu/~author/$key.pdf" \
        -F "title_hint=$key" "$origin/capture-bytes"
    echo "root: $root"
    curl --silent --show-error -X POST "$origin/api/items/$key/extractions/{{plugin}}"

[doc("Seed empty, broken and 1,000-PDF bucket stores; screenshot every library state into docs/m2 (Chromium at 1600x1000, WebKitGTK on a headless 1400x900 display, the desktop window size) and print the load timings.")]
library-screenshots: build-web
    @uv run --script scripts/library_screenshots.py docs/m2

[doc("Screenshot the send action's states (idle, sending, failed, sent, refused, remove) into docs/m3 against a two-item bucket whose Zotero is a closed port, so nothing reaches a real library.")]
send-screenshots: build-web
    @uv run --script scripts/library_screenshots.py send docs/m3

[doc("Screenshot the inspector's extraction runs (idle, running, succeeded, failed, rejected) into docs/m4 against the committed fixture extractor, so no provider is called.")]
extract-screenshots: build-web
    @uv run --script scripts/library_screenshots.py extract docs/m4

[doc("Export, wipe, import and rebuild a temporary store through the recipes above, then delete three PDFs (one at a URL the fixture publisher has taken down) and rebuild again; prints the transcript.")]
cache-evidence:
    @bun run cache-evidence
