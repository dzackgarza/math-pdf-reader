#!/usr/bin/env bash
# Build the web bundle and the release desktop app, install the app with its launcher entry,
# icons and login autostart, and start it; the app starts the bucket server. Called by `just
# provision` from the repository root.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"
# The app loads the provider keys with `direnv export json`; a blocked .envrc fails here.
direnv exec "$repo" true
bun install --frozen-lockfile
uv sync --locked
bunx vite build --config src/web/vite.config.ts
(cd desktop && bunx @tauri-apps/cli build --no-bundle)

config="${XDG_CONFIG_HOME:-$HOME/.config}"
data="${XDG_DATA_HOME:-$HOME/.local/share}"
units="$config/systemd/user"
autostart_unit='app-pdf\x2dbucket\x2ddesktop@autostart.service'

# A running app keeps the previous binary and its server; it quits here, and its server with it.
if systemctl --user is-active --quiet "$autostart_unit"; then
    systemctl --user stop "$autostart_unit"
fi
# An app started from the launcher or a terminal runs outside systemd. pgrep matches the kernel's
# 15-character process name; killall needs the full name to match a longer one.
if pgrep -x pdf-bucket-desk > /dev/null; then
    killall --wait pdf-bucket-desktop
fi

# The app runs an installed copy, so later builds can rewrite the build tree while it runs.
install -D -m 755 desktop/src-tauri/target/release/pdf-bucket-desktop "$HOME/.local/bin/pdf-bucket-desktop"
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
