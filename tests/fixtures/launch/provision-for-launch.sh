#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
printf '%s\n' "$*" >> "$RECORD/provision"
sleep "${BUILD_SECONDS:-0}"
if [[ -n "${BUILD_FAILS:-}" ]]; then
    echo "the build stopped"
    exit 3
fi
build="$(wc -l < "$RECORD/provision")"
mkdir -p "$HOME/.local/bin" "$XDG_DATA_HOME/pdf-bucket-app"
cat > "$HOME/.local/bin/pdf-bucket-desktop" <<APP
#!/usr/bin/env bash
printf '%s\n' "build $build \$*" >> "\$RECORD/app"
APP
chmod 755 "$HOME/.local/bin/pdf-bucket-desktop"
"$repo/scripts/source-fingerprint" > "$XDG_DATA_HOME/pdf-bucket-app/source-fingerprint"
