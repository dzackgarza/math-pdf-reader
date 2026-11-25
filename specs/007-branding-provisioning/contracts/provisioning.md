# Contract: Launcher, Provisioning and Extension Status

## `scripts/launch [args…]`

The only start path. The desktop entry, the autostart entry and `~/.local/bin/pdf-bucket`
run it.

| Condition (under `flock` on `$XDG_DATA_HOME/pdf-bucket-app/launch.lock`) | Effect | Exit |
| --- | --- | --- |
| binary present and stamp equals `scripts/source-fingerprint` | `exec ~/.local/bin/pdf-bucket-desktop args…`; no build | the app's |
| binary missing, stamp missing, or stamp differs | notification "Source changed: rebuilding before launch"; `kitty --title "Math PDF Reader - Building"` runs `just provision-for-launch`; then `exec` the new binary | the app's |
| that rebuild fails | the terminal prints "Rebuild failed (exit N). Press Enter to close." and waits; critical notification "rebuild failed; see the Math PDF Reader build terminal for details"; the app does not start | 1 |
| rebuild needed and `kitty` not on `PATH` | critical notification "kitty is required to show the rebuild output"; the app does not start | 1 |

## `scripts/source-fingerprint`

Prints one hash of the content and path of every tracked or untracked, non-ignored file
in the application input. Required property (FR-005): an edit that touches only extension
input leaves the output unchanged. Extension input is `src/extension/**`, `wxt.config.ts`,
and the scripts that only extension provisioning reads (`scripts/amo_signed.py`,
`scripts/firefox-policy.sh`). The current list breaks this property for the two scripts.

## `just provision` / `just provision-for-launch`

Build and install the app, then write `source-fingerprint` last. `provision` also starts
the autostart unit. `provision-for-launch` does not start the app. Neither builds, signs
or installs an extension.

## `just _provision-extensions`

| Condition | Effect |
| --- | --- |
| extension input hash equals `extension-fingerprint` | prints "browser extensions are already provisioned"; exit 0; nothing built |
| Firefox policy missing | exit 1 with the instruction `just firefox-policy` |
| Chromium does not load `extensions/chrome-mv3` | exit 1 with the load instruction |
| otherwise | build both, install `chrome-mv3`, get or make the AMO unlisted signature, install `firefox.xpi` and `firefox-mv2`, write `extension-fingerprint` |

## `GET /status` (extension fields)

```json
{ "extensions": { "chrome": "1.0.512" | null, "firefox": "1.0.512" | null } }
```

`null`: no manifest in that browser's installed build directory. Schema:
`ServerStatusSchema` in `src/contract/capture.ts`.

## `GET /extension/updates.json`, `GET /extension/firefox.xpi`

The Firefox update manifest names the gecko id, the provisioned version, the package URL
and its `sha256:` hash. The package is the AMO-signed `firefox.xpi`
(`application/x-xpinstall`). With no signed build: 404 with
`{"error": {"kind": "unknown_extension_build", …}}`.

## Extension status (`checkBucket` in `src/extension/bucket-status.ts`)

| Reported version | Own version | State | Badge | Captures |
| --- | --- | --- | --- | --- |
| equal | — | ready / not-ready | `ON` / `OFF` | accepted when ready |
| differs, not null | — | stale | `OLD` | refused; the popup shows This build, Provisioned, Replacement |
| `null` | — | ready / not-ready (today) | `ON` / `OFF` | accepted |
| no status report | — | unreachable | `!` | refused with the error page |
