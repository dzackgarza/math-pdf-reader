# PDF Bucket

A standalone desktop app that replaces reading PDFs in the browser.
Browser extensions intercept PDF navigations in Chrome and Firefox and hand the PDF to the bucket, which stores it with embedded provenance, opens it in a PDF.js reader, and lets you file it, extract it, and send it to Zotero when it matters.

## Layout

| Path | What it is |
| --- | --- |
| `server/` | Rust (axum) bucket server: capture endpoint, PDF and reader URLs, library API, index export, the store's file layout and every write to it, the plugin runners; `pdf-bucket` CLI (`serve`, `export-index`, `import-index`, `rebuild-cache`, `forget`) |
| `src/contract` | zod contracts for the API, the store's answers, the config and the documents; the server's Rust types are generated from them |
| `src/web` | React library UI served by the server |
| `src/extension` | WXT WebExtension, built for Chrome and Firefox |
| `desktop/` | Tauri app: the window, the tray, and the bucket server in the same process |
| `src/pdfbucket` | Python package: the pikepdf and MuPDF commands the server runs (embed provenance and metadata, read a PDF's record and identifiers, render a thumbnail) |
| `plugins/manifests` | Shipped extraction and resolver plugin manifests |
| `src/resolvers` | Resolver plugins: an identifier or URL on stdin, one BibTeX entry on stdout |
| `tests/` | Bun tests (`*.test.ts`) and Python tests (`test_*.py`) |
| `tests/fixtures` | Everything the tests and evidence scripts consume, including the Zotero Connector build (zip) |

## Data

Stored PDFs, the filing (`organization.json`), the reading sessions (`reading-sessions.json`) and the keys removed on purpose (`removed.json`) live in `$XDG_DATA_HOME/pdf-bucket` (`~/.local/share/pdf-bucket` when `XDG_DATA_HOME` is unset).
The index export lives beside it, in `$XDG_DATA_HOME/pdf-bucket-export/index.json`: every stored item's provenance, filing and a record of its extraction files, and the collections, saved searches and reading sessions, in key order with a fixed field order, so two exports diff line by line.
The app rewrites it after every capture, filing change and reading session; `just export-index` writes it on demand, safely while the app runs.

The export never drops an item whose PDF went missing without being deleted or sent: it refuses, and the library's status bar says so and names the items.
Rebuild them, or forget an item that is gone for good (`DELETE /api/missing/<key>`, or `just forget <key>`), which drops its filing and lets the export go on.
A delete or send records its key in `removed.json` before the PDF goes to the trash, so an export written after a quit or a crash still drops it.

If PDFs are lost, `just rebuild-cache` downloads each one the export lists from its recorded PDF URL into the same key, and stores it only when it hashes to the recorded original SHA-256. It prints one outcome per item (`present`, `restored`, `dead` with the HTTP status or network error, `changed` with both hashes) and exits 1 when any item was not restored.
If the whole data root is lost, `just import-index` restores the filing and the reading sessions into the new root first (the app may already have started there: an `organization.json` with no collections, saved searches, item filing or activity counts as empty), then `just rebuild-cache` restores the PDFs.

## Running

PDF Bucket runs while its app runs, like Zotero: the app is the bucket's server, as Zotero is the server of its local API, and **Quit PDF Bucket** in the tray stops it.
Closing the window hides it to the tray; the bucket keeps capturing.
Click the tray icon for **Show PDF Bucket** and **Quit PDF Bucket**. Starting PDF Bucket while it runs shows the running window.
If the bucket cannot serve (its port is taken, the PDF.js viewer is missing, the `.envrc` is blocked), the window shows why.

`just provision` builds the app, installs it at `~/.local/bin/pdf-bucket-desktop` with a launcher entry, an icon and a login autostart entry, and starts it.
Desktop sessions that run XDG autostart start it at login.
On Hyprland, the session target starts it: `just provision` adds a drop-in to `hyprland-session.target` (docs/m5.md).

### Hyprland

After a capture the window asks for focus.
By default Hyprland only marks it urgent.
To bring the window to the front with the captured PDF's tab, load the shipped window rule from the Hyprland Lua config (for example `~/.config/hypr/confs/windowrules.lua`):

```lua
dofile("<checkout>/desktop/hyprland/pdf-bucket.lua")
```

The rule sets `focus_on_activate` for the bucket window only.
`docs/m1.md` records the events with and without it.

## Browser extensions

`just build` (or `bun run build` for the extensions alone) writes:

| Path | Browser |
| --- | --- |
| `dist/chrome-mv3/` | Chrome and Chromium, Manifest V3 |
| `dist/firefox-mv2/` | Firefox, Manifest V2 |
| `dist/pdf-bucket-1.0.0-firefox.zip` | the same Firefox build as one installable package |
| `dist/firefox-signed/pdf-bucket-1.0.0-firefox.xpi` | the Firefox build signed by addons.mozilla.org (`just sign-firefox`), which a release Firefox installs |

The builds are unsigned.

A PDF link opens in the desktop window.
The browser tab goes back to the page you clicked the link on, or closes when it was opened only for the PDF. If PDF Bucket cannot save the PDF, the tab stays with the error and a link that opens the PDF in the browser.

Once installed, the extension has a toolbar button.
Its badge shows the state: `ON` means the bucket answers and PDF links go to it, `OFF` means capture is switched off in this browser, and `!` means the bucket is not reachable or cannot store PDFs.
Click the button to see the bucket's address, version and data folder, switch capture on or off for this browser, and see the last capture.
The same page is the extension's options page.

**Chrome or Chromium:** open `chrome://extensions`, turn on Developer mode, press **Load unpacked** and choose `dist/chrome-mv3`. The extension stays installed across restarts; after a rebuild press its reload button.

**Firefox.** Release Firefox installs only signed extensions permanently.
Three routes:

1. Temporary, any Firefox: open `about:debugging#/runtime/this-firefox`, press **Load Temporary Add-on** and choose `dist/firefox-mv2/manifest.json`. Firefox removes it when it quits.

2. Permanent, unsigned: in Firefox Developer Edition, Nightly or ESR, set `xpinstall.signatures.required` to `false` in `about:config`, then in `about:addons` choose **Install Add-on From File** and pick `dist/pdf-bucket-1.0.0-firefox.zip`. Release and Beta builds ignore that preference.

3. Permanent, signed, release Firefox: sign the build as an unlisted (self-distributed) add-on with API credentials from addons.mozilla.org (Tools → Manage API Keys), then install the signed `.xpi` from `about:addons`:

   ```bash
   bunx web-ext sign --channel unlisted --source-dir dist/firefox-mv2 --artifacts-dir dist \
       --api-key "$WEB_EXT_API_KEY" --api-secret "$WEB_EXT_API_SECRET"
   ```

## Commands

```bash
just                # list recipes
just run            # desktop app from source (`tauri dev`), serving the configured bucket
just build          # web bundle, both extension targets, desktop binary
just provision      # build, install and start the app
just export-index   # write the index export
just rebuild-cache  # re-download missing PDFs from the export
just test-push      # full QC gate
```

Agents: read `AGENTS.md` first.
