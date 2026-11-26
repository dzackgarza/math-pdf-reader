#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"
for_launch=0
[[ "${1:-}" == --for-launch ]] && for_launch=1
fingerprint="$(scripts/source-fingerprint)"
direnv exec "$repo" true
bun update @embedpdf/core @embedpdf/plugin-viewport @embedpdf/snippet
uv sync --locked
bunx vite build --config src/web/vite.config.ts
(cd desktop && bunx @tauri-apps/cli build --no-bundle)

config="${XDG_CONFIG_HOME:-$HOME/.config}"
data="${XDG_DATA_HOME:-$HOME/.local/share}"
installed="$data/pdf-bucket-app"

units="$config/systemd/user"
autostart_unit='app-pdf\x2dbucket\x2ddesktop@autostart.service'

if [[ $for_launch -eq 0 ]] && systemctl --user is-active --quiet "$autostart_unit"; then
    systemctl --user stop "$autostart_unit"
fi
if pgrep -x pdf-bucket-desk > /dev/null; then
    killall --wait pdf-bucket-desktop
fi

install -D -m 755 target/release/pdf-bucket-desktop "$HOME/.local/bin/pdf-bucket-desktop"
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
printf '%s\n' '#!/usr/bin/env bash' "exec $repo/scripts/launch \"\$@\"" > "$HOME/.local/bin/pdf-bucket"
chmod 755 "$HOME/.local/bin/pdf-bucket"
for size in 32x32 128x128; do
    install -D -m 644 "desktop/src-tauri/icons/$size.png" "$data/icons/hicolor/$size/apps/pdf-bucket-desktop.png"
done
mkdir -p "$data/applications" "$config/autostart"
sed -e "s|@LAUNCHER@|$HOME/.local/bin/pdf-bucket|g" desktop/pdf-bucket-desktop.desktop \
    > "$data/applications/pdf-bucket-desktop.desktop"
desktop-file-validate "$data/applications/pdf-bucket-desktop.desktop"
install -m 644 "$data/applications/pdf-bucket-desktop.desktop" "$config/autostart/pdf-bucket-desktop.desktop"
install -D -m 644 desktop/autostart/hyprland-session.conf "$units/hyprland-session.target.d/pdf-bucket.conf"

printf '%s' "$fingerprint" > "$installed/source-fingerprint"

systemctl --user daemon-reload
systemctl --user cat "$autostart_unit" > /dev/null
[[ $for_launch -eq 1 ]] && exit 0
systemctl --user start "$autostart_unit"
systemctl --user --no-pager status "$autostart_unit"
