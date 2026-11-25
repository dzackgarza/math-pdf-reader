# Implementation Plan: Math PDF Reader Runtime Foundation

**Branch**: `000-runtime-foundation` (Spec Kit identifier; delivery stays on `main`) |
**Date**: 2026-11-25 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/000-runtime-foundation/spec.md`

## Summary

The runtime foundation is the walking skeleton: one desktop process that serves the
bucket, a window that shows the library and reader tabs, and stable local addresses for
each stored PDF and its reader page. Most of it exists in the source. The launcher blocks
an old build. The window shows a report page when the bucket cannot serve. No automated
test exercises either failure path. The window smoke test does not load or reload a
reader address. This plan records the existing architecture and the work that remains:
regression tests for both failure paths, one wrong remedy in a failure message, and a
reader-address reload step in the desktop smoke test.

## Technical Context

**Language/Version**: Rust edition 2021 (server and Tauri shell), TypeScript with Bun
(web bundle, tests), Bash (launcher and provision scripts), Python 3.14 (desktop
WebDriver test, store commands)

**Primary Dependencies**: Tauri 2 with `tauri-plugin-single-instance`,
`tauri-plugin-dialog`, `tauri-plugin-opener`; Axum and Tokio; React and EmbedPDF in
`src/web`; Askama for the reader page template; Selenium with WebKitWebDriver and
headless Weston for the window test

**Storage**: Paper directories under `$XDG_DATA_HOME/pdf-bucket/<key>/`; the installed
runtime under `$XDG_DATA_HOME/pdf-bucket-app/` with the provision stamp
`source-fingerprint`

**Testing**: Bun real-HTTP tests against `pdf-bucket serve` (`tests/bucket.ts`);
Puppeteer reader tests in `tests/library-e2e.test.ts`; the release app driven through
its window in `tests/desktop_workflow.py` (`just test-desktop`)

**Target Platform**: The user's Linux desktop (Wayland, WebKitGTK); loopback HTTP on
the configured port (`pdf-bucket.config.json`, 8770)

**Project Type**: Desktop application with an in-process local HTTP server

**Performance Goals**: None stated by the spec

**Constraints**: The window never opens an old build and never stays blank when the
bucket cannot serve. A failure names its cause and the remedy. Reader and PDF
addresses depend only on the paper key.

**Scale/Scope**: One user, one process, one configured port; the skeleton needs one
stored PDF

## Constitution Check

*GATE: PASS before research; PASS after design.*

- **Architecture Constraints, stable URLs**: every PDF is at `/pdf/<key>.pdf` and
  every reader page at `/read/<key>` while the app runs (`server/src/reader.rs:9-15`,
  `server/src/app.rs:462-463`). This feature owns that rule.
- **Architecture Constraints, wiring only**: EmbedPDF renders in the reader
  (`src/web/reader/`); the server and shell add no viewer.
- **Principle I, provenance**: the reader keeps the original PDF URL from the PDF's
  embedded provenance apart from its local address (FR-005).
- **Principles II-V**: no obligation in this feature; features 001, 004, 005 and 009
  own them.
- **Development Workflow**: each new failure test fails before its fix. A user-visible
  change is complete only after `scripts/launch` installs the build and the behaviour
  is checked on port 8770.
- **Fail loudly**: the launcher and the window report each failure. Neither falls back
  to an old build or a blank page.

## Project Structure

### Documentation (this feature)

```text
specs/000-runtime-foundation/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/runtime.md
└── tasks.md
```

### Source Code (repository root)

```text
scripts/
├── launch               # Fingerprint check, rebuild before start, failure notification
├── source-fingerprint   # Hash of every build input
└── provision.sh         # Build, install, stamp last, start
desktop/
├── src/index.html                 # The window's own page; shows a failure report from its fragment
└── src-tauri/src/
    ├── lib.rs                     # start(), StartFailure, failure_page, show_failure, window build
    ├── process_config.rs          # EnvrcFailure from `direnv export json`
    └── follow-open-events.js      # open-reader event: show and focus the window
server/
├── src/lib.rs                     # serve(): migrate, bind, route
├── src/app.rs                     # /pdf/{file}, /read/{key}, /status, router
├── src/reader.rs                  # pdf_url_path, reader_url_path, reader page
├── src/config.rs                  # installed runtime paths (web_dir under pdf-bucket-app)
└── templates/reader.html          # Highwire tags and the reader mount
src/web/
├── tabs.tsx                       # Reader tabs opened from open-reader events
├── routes.ts                      # readerPath(key)
└── reader/                        # EmbedPDF reader; copy-link uses provenance.pdf_url
tests/
├── desktop_workflow.py            # Release app through its window
├── server-capture.test.ts         # PDF and reader addresses, unknown keys
├── server-import.test.ts          # Addresses of imported PDFs
└── library-e2e.test.ts            # Reader revisits and the copied original URL
```

**Structure Decision**: Keep the current owners. `desktop/src-tauri/src/lib.rs` owns
startup and the window's failure page. `scripts/launch` owns build freshness.
`server/src/reader.rs` owns address derivation. New tests extend
`tests/desktop_workflow.py`. `tests/launch.test.ts` exercises the launcher.

## Design

### Startup sequence

1. `scripts/launch` takes `launch.lock`, then compares `scripts/source-fingerprint`
   with the stamp. If the stamp differs or is absent, or the binary is missing, it runs
   `just provision-for-launch` in a kitty terminal. If that run fails, the launcher
   prints the cause, sends a critical notification and exits 1. It does not start the
   installed binary.
2. `scripts/provision.sh` writes the stamp last, so an incomplete install never matches.
3. The binary starts `pdf_bucket::serve` in-process (`start()` in `lib.rs`). The
   result is either a bound origin or a `StartFailure`: a blocked `.envrc`, a data root
   that cannot be made, a missing web bundle, a bad port, or a bind or migration error.
4. The window opens on its own page, `desktop/src/index.html`. After the first load it
   goes to the bucket origin, or to its own page with the percent-encoded report in the
   fragment. The page shows "Math PDF Reader is not serving" and the report.
5. If the server task ends later, `show_failure` takes the window to the same report
   page.

### Addresses

`reader_url_path(key)` and `pdf_url_path(key)` percent-encode the key. The capture
response and the `open-reader` event carry the local `reader_url` and `pdf_url`. The
original PDF URL is only in `provenance.pdf_url`, embedded in the PDF. The reader's
Copy PDF link copies `provenance.pdf_url`. The reader page's `citation_pdf_url` names
the local PDF address.

### Gaps found in the source

- `StartFailure::NoWebBundle` tells the user to run `just build-web`. That recipe
  writes the checkout's `dist/web`, but the installed app reads
  `$XDG_DATA_HOME/pdf-bucket-app/dist/web` (`server/src/config.rs:84-86`). Only
  `just provision` writes that copy, so the stated remedy does not repair the failure.
- No test opens the window when the bucket cannot serve.
- The desktop smoke test checks that the window reaches the origin and renders a
  captured PDF in a tab. It does not load or reload the returned reader address in the
  window.

## Risks and stop rules

- A launcher test must never run the real provision against the user's home. Use a
  scratch `HOME` and `XDG_DATA_HOME`, and inject the build failure on the build command
  path.
- A window failure test needs the fixed port. It runs inside the existing
  `unshare -rn` namespace of `just test-desktop`.

## Complexity Tracking

No constitution violations.
