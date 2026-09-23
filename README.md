# PDF Bucket

A standalone desktop app that replaces reading PDFs in the browser.
Browser extensions intercept PDF navigations in Chrome and Firefox and hand the PDF to the bucket, which stores it with embedded provenance, opens it in a PDF.js reader, and lets you file it, extract it, and send it to Zotero when it matters.

## Layout

| Path | What it is |
| --- | --- |
| `src/server` | Bun + Hono server: capture endpoint, PDF and reader URLs, library API, index export |
| `src/web` | React library UI served by the server |
| `src/extension` | WXT WebExtension, built for Chrome and Firefox |
| `desktop/` | Tauri window that loads the server URL |
| `src/pdfbucket` | Python package: provenance embedding, PDF store, plugin manifest contract |
| `systemd/` | User unit templates that `just provision` renders and installs |
| `plugins/manifests` | Shipped extraction and resolver plugin manifests |
| `tests/` | Bun tests (`*.test.ts`) and Python tests (`test_*.py`) |
| `tests/fixtures` | Everything the tests and evidence scripts consume, including the Zotero Connector build (zip) |

## Data

Stored PDFs and the filing (`organization.json`) live in `$XDG_DATA_HOME/pdf-bucket` (`~/.local/share/pdf-bucket` when `XDG_DATA_HOME` is unset).
The index export lives beside it, in `$XDG_DATA_HOME/pdf-bucket-export/index.json`: every stored item's provenance and filing, and the collections and saved searches, in key order with a fixed field order, so two exports diff line by line.
The provisioned timer rewrites it every hour; `just export-index` writes it on demand.

If PDFs are lost, `just rebuild-cache` downloads each one the export lists from its recorded PDF URL into the same key, and stores it only when it hashes to the recorded original SHA-256. It prints one outcome per item (`present`, `restored`, `dead` with the HTTP status or network error, `changed` with both hashes) and exits 1 when any item was not restored.
If the whole data root is lost, `just import-index` restores the filing into the empty root first, then `just rebuild-cache` restores the PDFs.

## Always on

`just provision` builds the web bundle, the PDF.js viewer and the desktop binary, then installs and enables three user units rendered for the checkout it runs in:

| Unit | Starts | What it runs |
| --- | --- | --- |
| `pdf-bucket.service` | at login (`default.target`) | the server on the configured port, with the provider keys from `direnv` |
| `pdf-bucket-window.service` | with the graphical session (`graphical-session.target`), after the server answers `/status` | the release desktop binary, installed at `~/.local/bin/pdf-bucket-desktop` |
| `pdf-bucket-export.timer` | hourly | `just export-index` |

A unit that fails to start is retried twice and then stays failed; `systemctl --user status pdf-bucket` and `journalctl --user -u pdf-bucket` show why.
The window starts at login only when the session reaches `graphical-session.target`: a compositor started through `uwsm` does, and so does a session target bound to it, such as `hyprland-session.target` started from the compositor's startup (docs/m5.md shows the one used on the development workstation).

## Browser extensions

`just build` (or `bun run build` for the extensions alone) writes:

| Path | Browser |
| --- | --- |
| `dist/chrome-mv3/` | Chrome and Chromium, Manifest V3 |
| `dist/firefox-mv2/` | Firefox, Manifest V2 |
| `dist/pdf-bucket-0.1.0-firefox.zip` | the same Firefox build as one installable package |

The builds are unsigned.

**Chrome or Chromium:** open `chrome://extensions`, turn on Developer mode, press **Load unpacked** and choose `dist/chrome-mv3`. The extension stays installed across restarts; after a rebuild press its reload button.

**Firefox.** Release Firefox installs only signed extensions permanently.
Three routes:

1. Temporary, any Firefox: open `about:debugging#/runtime/this-firefox`, press **Load Temporary Add-on** and choose `dist/firefox-mv2/manifest.json`. Firefox removes it when it quits.

2. Permanent, unsigned: in Firefox Developer Edition, Nightly or ESR, set `xpinstall.signatures.required` to `false` in `about:config`, then in `about:addons` choose **Install Add-on From File** and pick `dist/pdf-bucket-0.1.0-firefox.zip`. Release and Beta builds ignore that preference.

3. Permanent, signed, release Firefox: sign the build as an unlisted (self-distributed) add-on with API credentials from addons.mozilla.org (Tools → Manage API Keys), then install the signed `.xpi` from `about:addons`:

   ```bash
   bunx web-ext sign --channel unlisted --source-dir dist/firefox-mv2 --artifacts-dir dist \
       --api-key "$WEB_EXT_API_KEY" --api-secret "$WEB_EXT_API_SECRET"
   ```

## Commands

```bash
just                # list recipes
just serve          # bucket server on the host and port in pdf-bucket.config.json
just run            # desktop window (starts the server first)
just build          # web bundle, both extension targets, desktop binary
just provision      # build, then install and start the systemd user units
just export-index   # write the index export
just rebuild-cache  # re-download missing PDFs from the export
just test-push      # full QC gate
```

Agents: read `AGENTS.md` first.
