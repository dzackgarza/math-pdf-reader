# PDF Bucket

A standalone desktop app that replaces reading PDFs in the browser.
Browser extensions intercept PDF navigations in Chrome and Firefox and hand the PDF to the bucket, which stores it with embedded provenance, opens it in an EmbedPDF reader, and lets you file it, extract it, and send it to Zotero when it matters.

## Layout

| Path | What it is |
| --- | --- |
| `server/` | Rust (axum) bucket server: capture endpoint, PDF and reader URLs, library API, index export, the store's file layout and every write to it, the plugin runners; `pdf-bucket` CLI (`serve`, `export-index`, `import-index`, `rebuild-cache`, `forget`) |
| `src/contract` | zod contracts for the API, the store's answers, the config and the documents; the server's Rust types are generated from them |
| `src/web` | React library UI served by the server |
| `src/extension` | WXT WebExtension, built for Chrome and Firefox |
| `desktop/` | Tauri app: the window, the tray, and the bucket server in the same process |
| `src/pdfbucket` | Python package: the pikepdf and MuPDF commands the server runs (embed provenance and metadata, infer metadata, read a PDF's record, render a thumbnail) |
| `plugins/manifests` | Shipped extraction plugin manifest |
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
If the bucket cannot serve (its port is taken, the web bundle is missing, the `.envrc` is blocked), the window shows why.

`just provision` builds the app, installs it at `~/.local/bin/pdf-bucket-desktop` with a launcher entry, an icon and a login autostart entry, and starts it.
Desktop sessions that run XDG autostart start it at login.
On Hyprland, the session target starts it: `just provision` adds a drop-in to `hyprland-session.target` (docs/m5.md).

### Assistant pane

Every PDF tab has a collapsible right sidebar (collapsed by default, resizable by its left edge, both remembered) that shows OpenCode's own web UI in a frame, one chat per stored PDF.
The app runs `opencode serve` privately for it: loopback port `ai.port`, its own data (sessions) under `$XDG_DATA_HOME/pdf-bucket-ai`, and a generated password in the file `password` there. It reads your own OpenCode config and model catalogue (providers, models), and your logins (`auth.json`) are linked in; the `reader` agent is layered over them. The server starts on the first expanded pane and ends with the app.
The chat uses the `reader` agent on `ai.model`. That agent runs no command, edits no file and starts no sub-agent. It may fetch only from the bucket: the PDF's text at `GET /api/ai/text/{key}` (`?page=N` for one page); once a PDF has a stored extraction (docs/m4.md), the text is that Markdown. The chat always carries what the reader shows (the page, and where it lies in the extraction) as an instruction entry that the bucket updates at each page the reader reports; the page's text is at `GET /api/ai/view/{key}`.
If `ai.binary` is not on the app's PATH, or the server does not answer within `ai.startup_timeout_seconds`, the pane shows the reason (the server's log is `opencode.log` in the same directory) and **Try again**.

### Hyprland

After a capture the window asks for focus.
By default Hyprland only marks it urgent.
To bring the window to the front with the captured PDF's tab, load the shipped window rule from the Hyprland Lua config (for example `~/.config/hypr/confs/windowrules.lua`):

```lua
dofile("<checkout>/desktop/hyprland/pdf-bucket.lua")
```

The rule sets `focus_on_activate` for the bucket window only.
`docs/m1.md` records the events with and without it.

### Logs

Each run of the app writes `$XDG_STATE_HOME/pdf-bucket/logs/<start time>-<pid>.log` (`~/.local/state/pdf-bucket/logs` when `XDG_STATE_HOME` is unset). The app keeps the newest 30 runs.
The file holds the timestamped stderr of the app and of its WebKit web and network processes. The journal gets the same lines without the timestamps.
The `diag:` lines record:

| Event | Lines |
| --- | --- |
| start | process id, log path, the `WEBKIT_*`, `GDK_*`, `GSK_*`, `WAYLAND_*`, `LIBGL_*` and `MESA_*` environment, WebKit's hardware acceleration policy |
| renderer | web process terminated (with the reason), web process responsive or not, failed loads |
| window | Tauri window events, GTK map and unmap of the window and the webview, webview size and scale, window state |
| system | suspend and resume, from logind's `PrepareForSleep` |
| page | `page {...}`: load, visibility and page lifecycle, uncaught errors, unhandled rejections, lost canvas contexts |
| probe | every 5 minutes, and 0, 2 and 15 seconds after a resume: renderer and widget state, then whether the page answered and drew a frame within 5 seconds |

A probe that the page answered without a frame means the web process runs but draws nothing.
A probe the page did not answer means the page's script does not run or cannot reach the app.

## Browser extensions

Each extension exists once, in `~/.local/share/pdf-bucket-app/extensions`:

| Path | Browser |
| --- | --- |
| `chrome-mv3/` | Chrome and Chromium, Manifest V3, loaded unpacked |
| `firefox-mv2/` and `firefox.xpi` | Firefox, Manifest V2, and its package signed by addons.mozilla.org |

`just provision`, which every push runs, builds both from the pushed commit, installs them there, and removes the builds from the checkout.
addons.mozilla.org signs a changed Firefox build as an unlisted add-on during the provision.
The version is `1.0.<n>`, where `<n>` is the number of commits in the checkout, so each commit's build has a greater version than the one before.
The bucket reports the provisioned versions at `/status`. An extension whose version differs refuses every capture, shows `OLD` on its badge, and waits for the provisioned build:

- Chromium reloads it from the installed directory within a minute.

- Firefox installs it from the bucket at its next add-on update check, within a few minutes.

A PDF link opens in the desktop window.
The browser tab goes back to the page you clicked the link on, or closes when it was opened only for the PDF. If PDF Bucket cannot save the PDF, the tab stays with the error and a link that opens the PDF in the browser.

Once installed, the extension has a toolbar button.
Its badge shows the state: `ON` means the bucket answers and PDF links go to it, `OFF` means capture is switched off in this browser, `OLD` means the extension is not the provisioned build, and `!` means the bucket is not reachable or cannot store PDFs.
Click the button to see the bucket's address, version and data folder, switch capture on or off for this browser, and see the last capture.
The same page is the extension's options page.

Each browser needs one setup step, and `just provision` stops until it is done:

- **Chrome or Chromium:** run `just provision` once, so that the installed directory exists.
  Then open `chrome://extensions`, turn on Developer mode, remove any other PDF Bucket, press **Load unpacked** and choose `~/.local/share/pdf-bucket-app/extensions/chrome-mv3`.

- **Firefox:** run `just firefox-policy`, which asks for sudo, then restart Firefox.
  The recipe merges an enterprise policy into `/etc/firefox/policies/policies.json`: Firefox force-installs the add-on from the bucket, checks the bucket for updates, and checks every add-on for updates each 120 seconds.

## Commands

```bash
just                # list recipes
just run            # desktop app from source (`tauri dev`), serving the configured bucket
just build          # web bundle, both extension targets, desktop binary
just provision      # build, install and start the app
just export-index   # write the index export
just rebuild-cache  # re-download missing PDFs from the export
just test-push      # push gate: the Python and Bun suites, then provision
just test-desktop   # the desktop workflow through the release app (CI runs it with test-ci)
```

Agents: read `AGENTS.md` first.
