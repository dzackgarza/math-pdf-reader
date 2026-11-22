#!/usr/bin/env bash
# Build the web bundle and the release desktop app, install the app with its launcher entry,
# icons and login autostart, and start it; the app is the bucket server. Called by `just provision`
# from the repository root, and with --for-launch by scripts/launch (`just provision-for-launch`),
# which starts the app itself: then this script neither stops nor starts the autostart unit, which
# may be the launch that runs it.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"
for_launch=0
[[ "${1:-}" == --for-launch ]] && for_launch=1
# Hashed before building: an edit during the build leaves the stamp stale, so the next launch
# provisions again.
fingerprint="$(scripts/source-fingerprint)"
# The app reads the provider keys with `direnv export json`; a blocked .envrc fails here.
direnv exec "$repo" true
bun install --frozen-lockfile
uv sync --locked
bunx vite build --config src/web/vite.config.ts
(cd desktop && bunx @tauri-apps/cli build --no-bundle)

config="${XDG_CONFIG_HOME:-$HOME/.config}"
data="${XDG_DATA_HOME:-$HOME/.local/share}"
installed="$data/pdf-bucket-app"

units="$config/systemd/user"
autostart_unit='app-pdf\x2dbucket\x2ddesktop@autostart.service'

# A running app keeps the previous binary and the bucket's port; it quits here.
if [[ $for_launch -eq 0 ]] && systemctl --user is-active --quiet "$autostart_unit"; then
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
# so a later change to the checkout leaves the installed app as it was built: the web bundle (the
# library and the reader), the extraction manifest, and a Python environment made from a wheel of
# this checkout's package with the locked dependencies.
mkdir -p "$installed/dist/web"
rsync -a --delete dist/web/ "$installed/dist/web/"
install -D -m 644 plugins/manifests/extractions.json "$installed/plugins/manifests/extractions.json"
wheels=$(mktemp -d)
uv build --wheel --out-dir "$wheels"
uv export --locked --no-dev --no-emit-project --format requirements-txt --output-file "$wheels/requirements.txt"
venv="$installed/.venv"
uv venv --clear --python 3.14 "$venv"
uv pip install --python "$venv/bin/python" --requirement "$wheels/requirements.txt" "$wheels"/pdfbucket-*.whl
trash "$wheels"
# The launcher rebuilds first when the source changed, so no start runs an old build.
printf '%s\n' '#!/usr/bin/env bash' "exec $repo/scripts/launch \"\$@\"" > "$HOME/.local/bin/pdf-bucket"
chmod 755 "$HOME/.local/bin/pdf-bucket"
# Launcher and autostart entry and the icon, named after the window's Wayland app_id (the binary
# name) so that launchers and taskbars match the running window to them.
for size in 32x32 128x128; do
    install -D -m 644 "desktop/src-tauri/icons/$size.png" "$data/icons/hicolor/$size/apps/pdf-bucket-desktop.png"
done
mkdir -p "$data/applications" "$config/autostart"
sed -e "s|@LAUNCHER@|$HOME/.local/bin/pdf-bucket|g" desktop/pdf-bucket-desktop.desktop \
    > "$data/applications/pdf-bucket-desktop.desktop"
desktop-file-validate "$data/applications/pdf-bucket-desktop.desktop"
install -m 644 "$data/applications/pdf-bucket-desktop.desktop" "$config/autostart/pdf-bucket-desktop.desktop"
# Sessions that run XDG autostart start the entry by themselves. This Hyprland session starts
# hyprland-session.target instead, and the drop-in makes that target start the entry's unit.
install -D -m 644 desktop/autostart/hyprland-session.conf "$units/hyprland-session.target.d/pdf-bucket.conf"

# The stamp the launcher compares: the app and its runtime files are complete.
printf '%s' "$fingerprint" > "$installed/source-fingerprint"

systemctl --user daemon-reload
# systemd-xdg-autostart-generator makes the unit from the autostart entry at daemon-reload;
# `systemd-analyze verify` does not search the generator directories, `systemctl cat` does.
systemctl --user cat "$autostart_unit" > /dev/null
[[ $for_launch -eq 1 ]] && exit 0
systemctl --user start "$autostart_unit"
systemctl --user --no-pager status "$autostart_unit"
