# Implementation Plan: Math PDF Reader Identity and Provisioning

> Tier: implementation-adjacent
> Parent plan: `PLAN-PDF-BUCKET-ROADMAP` under `FEATURE-PDF-BUCKET`
> Externalized fit: existing roadmap issue tree; no new issue or PR is claimed.

**Branch**: `007-branding-provisioning` (Spec Kit identifier; delivery stays on `main`) |
**Date**: 2026-11-25 | **Spec**: [spec.md](spec.md)

## Summary

The product name, the launcher, application provisioning and extension provisioning
exist in the source. This feature was specified after they were built. The plan records
the existing architecture, the behaviours that have no test, and the behaviours that the
spec requires and the source does not supply. The main gaps are: extension-only scripts
in the application fingerprint, no visible provisioning state in the app, a Firefox build
that is not updated when the extension version does not change, browser provisioning that
one browser can block for the other, and visible compatibility identifiers.

## Technical Context

**Language/Version**: Bash (launcher and provisioning scripts), Rust edition 2021 (Tauri
desktop app and Axum server), TypeScript with Bun (WXT extensions, React library UI)

**Primary Dependencies**: Tauri 2, `tauri-plugin-single-instance`, WXT, `web-ext` (AMO
signing), `just`, `kitty` (rebuild terminal), `notify-send`, systemd user manager
(`systemd-xdg-autostart-generator`)

**Storage**: Installed runtime in `$XDG_DATA_HOME/pdf-bucket-app` (binary copy in
`~/.local/bin`, web bundle, plugin manifest, Python environment, extension builds) and
two stamp files: `source-fingerprint` and `extension-fingerprint`

**Testing**: Bun tests against the real server binary (`tests/server-status.test.ts`),
Puppeteer drives both built extensions (`tests/capture-e2e.test.ts`), WXT build checks
(`tests/extension-manifest.test.ts`), WebDriver desktop workflow (`tests/desktop_workflow.py`).
No test runs `scripts/launch`, `scripts/source-fingerprint` or either provisioning script.

**Target Platform**: The owner's Linux desktop (Hyprland, systemd user session), Chromium
with an unpacked extension, release Firefox with an enterprise policy

**Project Type**: Desktop application with a local HTTP server and two browser extensions

**Performance Goals**: None specified

**Constraints**: Tests must never install, restart or replace the owner's provisioned app
or browser extensions. Tier-1 tests use scratch `HOME`/`XDG_*` directories and a scratch
git worktree.

**Scale/Scope**: One application build family and two extension build families (Chrome,
Firefox)

## Constitution Check

*GATE: PASS. Re-checked after design: PASS.*

- **Development Workflow**: "User-visible changes are not complete until the normal
  launcher has installed the new app build." This feature owns that launcher. The
  launcher (`scripts/launch`) refuses to start a build older than the source.
- **Fail loudly**: a failed rebuild stops the launch with a notification and keeps the
  build output in a terminal. A stale extension refuses captures with a stated reason.
- **Architecture Constraints**: the app owns wiring only. Provisioning reuses Tauri,
  WXT, `web-ext` and the systemd XDG autostart generator. No new runtime component.
- **Principles I–V** (provenance, paper sources, assistant context): not touched by this
  feature. Embedded `/PDFBucket*` provenance keys stay as compatibility identifiers
  (FR-002) because existing PDFs carry them.

## Project Structure

### Documentation (this feature)

```text
specs/007-branding-provisioning/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/provisioning.md
└── tasks.md
```

### Source Code (repository root)

```text
scripts/
├── launch                  # the only start path: fingerprint check, visible rebuild, exec
├── source-fingerprint      # hash of the application build input
├── provision.sh            # app build and install; --for-launch for the launcher
├── provision-extensions.sh # extension build, Chromium install, AMO signing, stamp
├── amo_signed.py           # fetch an already-signed Firefox package from AMO
└── firefox-policy.sh       # Firefox enterprise policy for install and update
justfile                    # provision, provision-for-launch, _provision-extensions, firefox-policy
wxt.config.ts               # extension name and version (1.0.<commit count>)
desktop/
├── pdf-bucket-desktop.desktop   # launcher and autostart entry (Name=Math PDF Reader)
├── autostart/hyprland-session.conf
├── src/index.html               # failure page of the window
└── src-tauri/
    ├── tauri.conf.json          # productName and window title
    └── src/lib.rs               # dialogs, tray menu, server failure reports
server/src/
├── extensions.rs           # provisioned extension versions; Firefox update manifest and package
├── app.rs                  # GET /status
└── config.rs               # installed runtime paths
src/contract/capture.ts     # ServerStatusSchema (service name, extensions)
src/extension/
├── bucket-status.ts        # stale detection, replacement text, badge
├── entrypoints/background.ts   # capture refusal for a stale build
└── entrypoints/popup/      # status page
src/web/
├── screens/SettingsScreen.tsx  # Version row
└── components/StatusBar.tsx    # capture indicator, index export state
tests/
├── server-status.test.ts
├── capture-e2e.test.ts
├── extension-manifest.test.ts
├── desktop_workflow.py
└── launch.test.ts          # new: launcher and fingerprint tests
```

**Structure Decision**: Keep the existing owners. `scripts/launch` stays the only start
path. `scripts/source-fingerprint` stays the only definition of application input.
`/status` stays the one report that the extensions and the library read. Add one test
file for the launcher and the fingerprint.

## Design

### Product identity (US1, FR-001, FR-002)

The visible name comes from these sources:

| Surface | Source |
| --- | --- |
| window title, dialogs | `desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/src/lib.rs:32,154` |
| tray menu | `desktop/src-tauri/src/lib.rs:383-384` |
| launcher and autostart entry | `desktop/pdf-bucket-desktop.desktop` (`Name=`) |
| library and failure page titles | `src/web/index.html`, `desktop/src/index.html` |
| extension name | `wxt.config.ts:41` |
| popup, capture page, badge titles | `src/extension/entrypoints/popup/`, `capture/`, `bucket-status.ts` |
| rebuild terminal and notifications | `scripts/launch:14,21,38,40` |
| user documentation | `README.md` |

Compatibility identifiers stay where something outside the source depends on them: data
paths (`pdf-bucket`, `pdf-bucket-app`, `pdf-bucket-ai`, `pdf-bucket-export`), the binary
and Wayland app_id `pdf-bucket-desktop` (the desktop entry maps it with
`StartupWMClass`), the Tauri identifier and D-Bus name `com.dzackgarza.pdfbucket`, the
Firefox add-on id, the `/status` service name `pdf-bucket`, and the `/PDFBucket*` keys in
stored PDFs. FR-002 permits them while no surface shows them as the product name.

### Application provisioning (US2, FR-003, FR-004, FR-005)

`provision.sh` hashes the input (`scripts/source-fingerprint`) before it builds. It builds
the web bundle and the release binary, stops a running app, installs the binary and the
runtime files, writes the launcher wrapper `~/.local/bin/pdf-bucket`, the desktop entry,
the icons, the autostart entry and the Hyprland drop-in, and writes the stamp last
(`provision.sh:73`). The launcher entry, the autostart entry and the wrapper all run
`scripts/launch`. The launcher compares the stamp with a new hash under a lock
(`launch:34-41`). A difference, a missing stamp or a missing binary runs
`just provision-for-launch` in a `kitty` window. On failure the window waits for Enter,
and the launcher sends a critical notification and exits 1 without starting the app.

Required changes: remove the extension-only scripts from the application input, and make
the application build state visible in the app (see Gaps).

### Extension provisioning (US3, FR-006, FR-008)

The private recipe `just _provision-extensions` runs `provision-extensions.sh`. It hashes
the extension input, stops when the hash equals `extension-fingerprint`, and builds both
browsers with WXT. It installs the Chrome build in `extensions/chrome-mv3` and checks the
Firefox policy and the Chromium load path. Then it gets or makes an AMO unlisted
signature, installs `firefox.xpi` and `firefox-mv2`, and writes the stamp. The extension
version is `1.0.<commit count>` (`wxt.config.ts:24-27`).

The server reports each provisioned version at `/status` (`server/src/extensions.rs:60`)
and serves the signed Firefox package with its update manifest (`extensions.rs:87-116`).
Each extension compares its own version with the reported one
(`bucket-status.ts:66-70`). A difference is the `stale` state: the badge shows `OLD`, the
popup shows both versions and the replacement, and every capture and Send tabs is
refused before it posts (`background.ts:68-74,85-89,174-179`). Chromium reloads the
unpacked build once. Firefox takes the signed build at its next policy-driven update
check.

### Provisioning state (FR-007)

The data model defines the state per build family (current, stale, failed). Today only
the extensions show a state, and only the stale case. The app shows a constant crate
version (`SettingsScreen.tsx:218`, `config::VERSION`). It does not show whether it is the
current build, whether a rebuild failed, or which extension builds are provisioned.

## Gaps

These are the findings that the convergence phase of [tasks.md](tasks.md) lists:

1. `scripts/source-fingerprint:8` includes `scripts/amo_signed.py` and
   `scripts/firefox-policy.sh`. Only extension provisioning reads them. An edit to them
   rebuilds the app (FR-005, SC-004).
2. No surface in the app reports the application or extension provisioning state
   (FR-007, US3/AC2).
3. After a failed rebuild, an app that is already running stays on screen with no sign
   that it is stale. The failure is not kept after the terminal closes (FR-004, US2/AC2).
4. Extension input that has not been committed gets the same version as the installed
   build. AMO then returns the earlier signed package for that version, so Firefox keeps
   the old code while the stamp says current (US3/AC1, FR-007).
5. The Chromium load check in `provision-extensions.sh:42-46` stops Firefox signing, so
   one browser's setup blocks the other (US3/AC1, FR-008).
6. Visible compatibility identifiers: the status bar and the export refusal name
   `pdf-bucket forget <key>`, which the installed `pdf-bucket` (the launcher) does not run.
   The popup names `gtk-launch pdf-bucket-desktop` (FR-002, edge case).
7. The tray item sets no title or tooltip (`lib.rs:390`) (FR-001).
8. No test covers FR-001 to FR-008 except the `/status` extension report.

## Owner decision on "bucket"

"The bucket" in user-visible strings is the old product name (owner, 2026-11-25). Every
string the user reads names "Math PDF Reader", or "the app" where the product name does
not fit ("Math PDF Reader is not serving", "Math PDF Reader refused"). Code identifiers,
paths, and the reading-store term in repository docs stay. Task T034 applies this.

## Risks / Recovery / Stop Rules

- A launcher test that runs the real `provision.sh` would install over the owner's app.
  `provision.sh:35-37` also kills every process named `pdf-bucket-desktop`, and it runs
  `systemctl --user` on the real user manager, so scratch `XDG_*` directories do not
  isolate it. Tier-1 tests substitute the build command at the `PATH` boundary and use
  scratch directories. Tests never run the real build and install.
- An extension provisioning run signs a version on AMO once. A failed run can leave a
  signed version that the next run must fetch (`amo_signed.py`). Do not run signing in
  tests.
- Stop for the owner only for the "bucket" wording question above.

## Revision Notes

- 2026-11-25: First plan, written after the behaviour existed. Records the existing
  architecture and the gaps found against the spec.
