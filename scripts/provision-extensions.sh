#!/usr/bin/env bash
# Build, install and sign the browser extensions without rebuilding or restarting the app.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"
data="${XDG_DATA_HOME:-$HOME/.local/share}"
installed="$data/pdf-bucket-app"
extensions="$installed/extensions"

direnv exec "$repo" true
bun install --frozen-lockfile
extension_input="$(git ls-files -co --exclude-standard -z -- src/extension src/contract wxt.config.ts \
    pdf-bucket.config.json package.json bun.lock | sort -zu | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)"
mkdir -p "$extensions"
if [[ "$(cat "$installed/extension-fingerprint" 2> /dev/null)" == "$extension_input" ]]; then
    echo "browser extensions are already provisioned"
    exit 0
fi

bunx wxt build
bunx wxt build -b firefox
trap 'trash dist/chrome-mv3 dist/firefox-mv2' EXIT

unchanged() {
    [[ -d "$2" ]] &&
        diff -r --exclude=manifest.json "$1" "$2" > /dev/null &&
        [[ "$(jq -S 'del(.version)' "$1/manifest.json")" == "$(jq -S 'del(.version)' "$2/manifest.json")" ]]
}

if ! unchanged dist/chrome-mv3 "$extensions/chrome-mv3"; then
    rsync -a --delete dist/chrome-mv3/ "$extensions/chrome-mv3/"
fi

config="${XDG_CONFIG_HOME:-$HOME/.config}"
policy=/etc/firefox/policies/policies.json
if ! [[ -f "$policy" ]] ||
    ! jq -e --argjson ours "$(scripts/firefox-policy.sh)" '. * $ours == .' "$policy" > /dev/null; then
    echo "provision: $policy lacks the capture add-on's policy; run \`just firefox-policy\`, then restart Firefox" >&2
    exit 1
fi

if ! cat "$config"/chromium/*/Preferences "$config"/chromium/*/"Secure Preferences" 2> /dev/null |
    jq -e --arg dir "$extensions/chrome-mv3" -s 'any(.[].extensions.settings[]?; .path == $dir)' > /dev/null; then
    echo "provision: Chromium does not load the capture extension from $extensions/chrome-mv3; in chrome://extensions remove any other Math PDF Reader and press Load unpacked on that directory" >&2
    exit 1
fi

signing=$(mktemp -d)
signed=0
direnv exec "$repo" uv run --script scripts/amo_signed.py \
    "$(jq -r .capture.firefox_addon_id pdf-bucket.config.json)" \
    "$(jq -r .version dist/firefox-mv2/manifest.json)" "$signing/signed.xpi" || signed=$?
if [[ $signed -eq 2 ]]; then
    git archive --format=zip -o "$signing/source.zip" HEAD
    direnv exec "$repo" bash -c 'WEB_EXT_API_KEY="$MOZILLA_JWT_ISSUER" WEB_EXT_API_SECRET="$MOZILLA_JWT_SECRET" bunx web-ext sign --channel unlisted --source-dir dist/firefox-mv2 --artifacts-dir "$0" --upload-source-code "$0/source.zip"' "$signing"
elif [[ $signed -ne 0 ]]; then
    exit "$signed"
fi
mv "$signing"/*.xpi "$extensions/firefox.xpi"
rsync -a --delete dist/firefox-mv2/ "$extensions/firefox-mv2/"
trash "$signing"
printf '%s' "$extension_input" > "$installed/extension-fingerprint"
