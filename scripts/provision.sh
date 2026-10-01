#!/usr/bin/env bash
# Build the web bundle and the release desktop app, install the app with its launcher entry,
# icons and login autostart, and start it; the app is the bucket server. Called by `just provision`
# from the repository root.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"
# The app reads the provider keys with `direnv export json`; a blocked .envrc fails here.
direnv exec "$repo" true
bun install --frozen-lockfile
uv sync --locked
bunx vite build --config src/web/vite.config.ts
(cd desktop && bunx @tauri-apps/cli build --no-bundle)

config="${XDG_CONFIG_HOME:-$HOME/.config}"
data="${XDG_DATA_HOME:-$HOME/.local/share}"
installed="$data/pdf-bucket-app"

# The capture extensions, built from this commit into the extensions directory the bucket serves
# (server/src/extensions.rs). Each extension compares its version with the one `/status` names
# and refuses captures until the provisioned build replaces it.
bunx wxt build
bunx wxt build -b firefox
# The installed builds are the only ones: the checkout keeps none a browser could load.
trap 'trash dist/chrome-mv3 dist/firefox-mv2' EXIT
extensions="$installed/extensions"
mkdir -p "$extensions"

# Whether build $1 equals the installed build $2 but for the version the commit gives it.
unchanged() {
    [[ -d "$2" ]] &&
        diff -r --exclude=manifest.json "$1" "$2" > /dev/null &&
        [[ "$(jq -S 'del(.version)' "$1/manifest.json")" == "$(jq -S 'del(.version)' "$2/manifest.json")" ]]
}

# Chromium reloads the unpacked build from the extensions directory (it keeps loaded unpacked
# extensions in each profile's Preferences or Secure Preferences). The directory is written
# before either check, so the first provision creates what Load unpacked needs.
if ! unchanged dist/chrome-mv3 "$extensions/chrome-mv3"; then
    rsync -a --delete dist/chrome-mv3/ "$extensions/chrome-mv3/"
fi

# Firefox installs and updates the add-on from the bucket only under the enterprise policy.
policy=/etc/firefox/policies/policies.json
if ! [[ -f "$policy" ]] ||
    ! jq -e --argjson ours "$(scripts/firefox-policy.sh)" '. * $ours == .' "$policy" > /dev/null; then
    echo "provision: $policy lacks the capture add-on's policy; run \`just firefox-policy\`, then restart Firefox" >&2
    exit 1
fi

if ! cat "$config"/chromium/*/Preferences "$config"/chromium/*/"Secure Preferences" 2> /dev/null |
    jq -e --arg dir "$extensions/chrome-mv3" -s 'any(.[].extensions.settings[]?; .path == $dir)' > /dev/null; then
    echo "provision: Chromium does not load the capture extension from $extensions/chrome-mv3; in chrome://extensions remove any other PDF Bucket and press Load unpacked on that directory" >&2
    exit 1
fi

# addons.mozilla.org signs a changed Firefox build as an unlisted add-on, with the committed
# source (its source-code policy, since the build is minified); it signs each version once, so an
# unchanged build keeps the package and version it was signed with. Credentials are
# MOZILLA_JWT_ISSUER and MOZILLA_JWT_SECRET from the environment direnv loads here.
if ! unchanged dist/firefox-mv2 "$extensions/firefox-mv2"; then
    signing=$(mktemp -d)
    # A run that uploaded this version but lost AMO's answer left it signed there.
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
    # The package first: the bucket names the version from the build's manifest.
    mv "$signing"/*.xpi "$extensions/firefox.xpi"
    rsync -a --delete dist/firefox-mv2/ "$extensions/firefox-mv2/"
    trash "$signing"
fi

units="$config/systemd/user"
autostart_unit='app-pdf\x2dbucket\x2ddesktop@autostart.service'

# A running app keeps the previous binary and the bucket's port; it quits here.
if systemctl --user is-active --quiet "$autostart_unit"; then
    systemctl --user stop "$autostart_unit"
fi
# An app started from the launcher or a terminal runs outside systemd. pgrep matches the kernel's
# 15-character process name; killall needs the full name to match a longer one.
if pgrep -x pdf-bucket-desk > /dev/null; then
    killall --wait pdf-bucket-desktop
fi

# The app runs an installed copy, so later builds can rewrite the build tree while it runs.
install -D -m 755 target/release/pdf-bucket-desktop "$HOME/.local/bin/pdf-bucket-desktop"
# It runs against its own copy of the runtime files, in the checkout's layout (config::installed),
# so a later change to the checkout leaves the installed app as it was built: the library bundle,
# the PDF.js viewer, the extraction manifest, and a Python environment made from a wheel of this
# checkout's package with the locked dependencies.
pdfjs="vendor/pdfjs-$(jq -r .pdfjs.version pdf-bucket.config.json)"
mkdir -p "$installed/dist/web" "$installed/$pdfjs"
rsync -a --delete dist/web/ "$installed/dist/web/"
rsync -a --delete "$pdfjs/" "$installed/$pdfjs/"
install -D -m 644 plugins/manifests/extractions.json "$installed/plugins/manifests/extractions.json"
wheels=$(mktemp -d)
uv build --wheel --out-dir "$wheels"
uv export --locked --no-dev --no-emit-project --format requirements-txt --output-file "$wheels/requirements.txt"
venv="$installed/.venv"
uv venv --clear --python 3.14 "$venv"
uv pip install --python "$venv/bin/python" --requirement "$wheels/requirements.txt" "$wheels"/pdfbucket-*.whl
trash "$wheels"
# Launcher and autostart entry and the icon, named after the window's Wayland app_id (the binary
# name) so that launchers and taskbars match the running window to them.
for size in 32x32 128x128; do
    install -D -m 644 "desktop/src-tauri/icons/$size.png" "$data/icons/hicolor/$size/apps/pdf-bucket-desktop.png"
done
mkdir -p "$data/applications" "$config/autostart"
sed -e "s|@BIN@|$HOME/.local/bin/pdf-bucket-desktop|g" desktop/pdf-bucket-desktop.desktop \
    > "$data/applications/pdf-bucket-desktop.desktop"
desktop-file-validate "$data/applications/pdf-bucket-desktop.desktop"
install -m 644 "$data/applications/pdf-bucket-desktop.desktop" "$config/autostart/pdf-bucket-desktop.desktop"
# Sessions that run XDG autostart start the entry by themselves. This Hyprland session starts
# hyprland-session.target instead, and the drop-in makes that target start the entry's unit.
install -D -m 644 desktop/autostart/hyprland-session.conf "$units/hyprland-session.target.d/pdf-bucket.conf"

systemctl --user daemon-reload
# systemd-xdg-autostart-generator makes the unit from the autostart entry at daemon-reload;
# `systemd-analyze verify` does not search the generator directories, `systemctl cat` does.
systemctl --user cat "$autostart_unit" > /dev/null
systemctl --user start "$autostart_unit"
systemctl --user --no-pager status "$autostart_unit"
