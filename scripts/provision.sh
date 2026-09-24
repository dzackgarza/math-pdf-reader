#!/usr/bin/env bash
# Build the release window and the web bundle, install the window binary with its launcher entry
# and icons, then render the systemd/ unit templates into the user unit directory and enable
# them. Called by `just provision` from the repository root.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"
# The server unit loads the provider keys through direnv; a blocked .envrc fails here.
direnv exec "$repo" true
bun install --frozen-lockfile
uv sync --locked
bunx vite build --config src/web/vite.config.ts
(cd desktop && bunx @tauri-apps/cli build --no-bundle)
# The unit runs an installed copy, so later builds can rewrite the build tree while the window runs.
install -D -m 755 desktop/src-tauri/target/release/pdf-bucket-desktop "$HOME/.local/bin/pdf-bucket-desktop"
# Launcher entry and its icon, named after the window's Wayland app_id (the binary name) so
# that launchers and taskbars match the running window to them.
data="${XDG_DATA_HOME:-$HOME/.local/share}"
for size in 32x32 128x128; do
    install -D -m 644 "desktop/src-tauri/icons/$size.png" "$data/icons/hicolor/$size/apps/pdf-bucket-desktop.png"
done
mkdir -p "$data/applications"
sed -e "s|@BIN@|$HOME/.local/bin/pdf-bucket-desktop|g" desktop/pdf-bucket-desktop.desktop \
    > "$data/applications/pdf-bucket-desktop.desktop"
desktop-file-validate "$data/applications/pdf-bucket-desktop.desktop"
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
