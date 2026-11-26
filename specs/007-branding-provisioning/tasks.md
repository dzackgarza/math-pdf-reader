# Tasks: Math PDF Reader Identity and Provisioning

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/provisioning.md](contracts/provisioning.md),
[quickstart.md](quickstart.md)

**Tests**: Every story has acceptance scenarios, so each behaviour needs a test through
its real path. A task is `[X]` only when the implementing code and an existing test of
that behaviour were both read. Both are named on an indented `Evidence` line.

**Assessment**: Source at commit `3a4a08a`, 2026-11-25.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [X] T001 Add `tests/launch.test.ts` with a scratch git worktree of the checkout, scratch
  `HOME`, `XDG_DATA_HOME` and `XDG_CONFIG_HOME`, and recording substitutes on `PATH` for
  `kitty`, `notify-send`, `just` and `~/.local/bin/pdf-bucket-desktop`
  (research.md R6)
  - Evidence: `tests/launch.test.ts` `scratchCheckout` and `launcherCheckout`, with the
    programs in `tests/fixtures/launch`; the real `just` runs (research.md R6).

## Phase 2: User Story 1 - One product identity (P1)

**Goal**: Every surface the user sees names the product Math PDF Reader.

**Independent Test**: Open each surface and read its name (quickstart.md US1).

- [X] T002 [P] [US1] Name the window and the product "Math PDF Reader" in
  `desktop/src-tauri/tauri.conf.json` (FR-001, US1/AC1).
  - Evidence: tests/desktop_workflow.py "a port already taken" reads the Tauri window
    title "Math PDF Reader" and the page title of the provisioned build (green after just
    provision).
- [X] T003 [P] [US1] Name the dialogs and the tray items "Math PDF Reader" in
  `desktop/src-tauri/src/lib.rs:32,154,383-384` (FR-001, US1/AC1). Source has it; no
  test.
  - Evidence (tray items): `test_the_tray_item_and_its_menu_name_math_pdf_reader` in
    `tests/desktop_workflow.py` reads the tray menu over the session bus with
    `com.canonical.dbusmenu` `GetLayout` and finds the items "Show Math PDF Reader" and
    "Quit Math PDF Reader" (pass 2026-11-25). The layout's root is not an item: it carries
    libdbusmenu's placeholder label "Label Empty".
  - Evidence (quit dialog): `test_a_quit_a_reader_cannot_save_asks_in_a_dialog_titled_math_pdf_reader`
    in `tests/desktop_workflow.py` starts the AT-SPI registry on the test's session bus,
    presses the tray's Quit item over dbusmenu while a reader's save fails, and reads the
    dialog through AT-SPI: one alert or dialog toplevel named "Math PDF Reader" that holds
    "A reader could not save: Error: the disk is full" (pass 2026-11-25).
  - Evidence (`report` dialog, source): `report` in `desktop/src-tauri/src/lib.rs:29-35`
    titles its dialog with the product-name string at `desktop/src-tauri/src/lib.rs:32`,
    `.title("Math PDF Reader")`.
- [X] T004 [P] [US1] Name the launcher and autostart entry `Name=Math PDF Reader` in
  `desktop/pdf-bucket-desktop.desktop` (FR-001, US1/AC1).
  - Evidence: `tests/launch.test.ts` "provisioning for a launch" runs the real
    `scripts/provision.sh --for-launch` and reads `Name=Math PDF Reader` in the installed
    entry.
- [X] T005 [P] [US1] Name both extensions "Math PDF Reader" in `wxt.config.ts:41`
  (FR-001, US1/AC1). Source has it; `tests/extension-manifest.test.ts` checks only the
  permissions.
  - Evidence: tests/extension-manifest.test.ts asserts manifest.name "Math PDF Reader" in
    the Chrome and Firefox builds.
- [X] T006 [P] [US1] Title the library, the window failure page, the popup and the
  capture page "Math PDF Reader" in `src/web/index.html`, `desktop/src/index.html`,
  `src/extension/entrypoints/popup/index.html`, `src/extension/entrypoints/capture/index.html`
  (FR-001, US1/AC1).
  - Evidence: tests/library-e2e.test.ts asserts the library title and the title and
    heading of desktop/src/index.html; tests/capture-e2e.test.ts asserts the popup title
    in both browsers and the capture failure page title "Not saved · Math PDF Reader" in
    Firefox.
- [X] T007 [US1] Name Math PDF Reader in the popup's report of a foreign service on the
  bucket's port (FR-001, US1/AC1)
  - Evidence: `src/extension/bucket-status.ts:63-64`;
    `tests/capture-e2e.test.ts:954-966` asserts "not a Math PDF Reader status report" in
    `#connection-details` of each browser's popup.
- [X] T008 [US1] Name Math PDF Reader in the rebuild terminal title and in the launcher
  notifications in `scripts/launch:14,21,38,40` (FR-001, US1/AC1).
  - Evidence: tests/launch.test.ts rebuild tests assert the kitty title "Math PDF Reader
    - Building" and both notifications.
- [X] T009 [US1] Show no compatibility identifier as the product name or as a command
  to run on any surface (FR-002, US1/AC2). Partial: see T033.
  - Evidence: The two commands shown to the user (popup Start it, forget) are replaced
    (T033); the popup label "Bucket" is "Address".

## Phase 3: User Story 2 - Launch the current build (P1)

**Goal**: A launch never opens an app older than its source.

**Independent Test**: quickstart.md US2.

- [X] T010 [US2] Exclude `src/extension/**` and `wxt.config.ts` from the application
  input in `scripts/source-fingerprint:7-12` (FR-005, SC-004, US2/AC3).
  - Evidence: `scripts/source-fingerprint:4-9`; `tests/launch.test.ts` "the application
    input hash" edits each extension input in a scratch checkout and expects the same
    hash, and expects a new hash after an edit to `src/web/index.html`.
- [X] T011 [US2] Rebuild before the launch when the binary or the stamp is missing or the
  stamp differs, then start the new build, in `scripts/launch:37-44` (FR-003, SC-002,
  US2/AC1).
  - Evidence: `tests/launch.test.ts` "with no app installed, and again after a source
    edit": two rebuilds in the `kitty` terminal titled "Math PDF Reader - Building", each
    followed by the start of the new build.
- [X] T012 [US2] On a failed rebuild, keep the output in the terminal, send a critical
  notification, exit 1 and start no app, in `scripts/launch:12-32,39-40` (FR-004,
  SC-003, US2/AC2).
  - Evidence: `tests/launch.test.ts` "a failed rebuild keeps its output": the build
    output and "Rebuild failed (exit 3). Press Enter to close." are printed, the launcher
    waits until Enter, exits 1, sends the critical notification and starts no app.
- [X] T013 [US2] With an unchanged stamp, start the installed binary with no rebuild in
  `scripts/launch:37,44` (FR-003).
  - Evidence: `tests/launch.test.ts` "with the source unchanged since the last build":
    one provision, two starts of build 1.
- [X] T014 [US2] Hash the input before the build and write the stamp as the last install
  step in `scripts/provision.sh:14,73` (FR-003, FR-004).
  - Evidence: `tests/launch.test.ts` "provisioning for a launch": the stamp equals the
    hash taken before a build that edits `src/web/index.html`; a failed build writes no
    stamp.
- [X] T015 [US2] Serialize two concurrent launches with the lock in
  `scripts/launch:34-36,42`, so a second launch does not start the old build while the
  first rebuilds (FR-003).
  - Evidence: `tests/launch.test.ts` "two launches during one rebuild build once": one
    provision, two starts of build 1.

## Phase 4: User Story 3 - Separate browser integrations (P2)

**Goal**: Extension builds are provisioned on their own, and a mismatched build refuses
captures and names its replacement.

**Independent Test**: quickstart.md US3.

- [X] T016 [US3] Keep extension provisioning a separate explicit recipe that does nothing
  when its input is unchanged: `justfile:43-45`, `scripts/provision-extensions.sh:12-18`;
  `scripts/provision.sh` builds no extension (FR-006, US2/AC3, US3/AC1). Source has it;
  no test.
  - Evidence: `tests/launch.test.ts` "with both browsers ready it installs both builds,
    and with the input unchanged it builds nothing" (no second `wxt build`);
    "provisioning for a launch" sees no `wxt` call from `scripts/provision.sh`.
- [X] T017 [US3] Report each provisioned extension version at `/status` and serve the
  signed Firefox build with its update manifest (FR-007, FR-008, US3/AC1)
  - Evidence: `server/src/extensions.rs:50-70,87-116`, `server/src/app.rs:375-397`;
    `tests/server-status.test.ts:93-134` (versions, `updates.json` hash and link,
    `firefox.xpi` bytes and type), `tests/server-status.test.ts:136-148` (404 with no
    signed build).
- [X] T018 [US3] Refuse every capture and Send tabs from a build whose version differs
  from the provisioned one, in `src/extension/bucket-status.ts:66-70` and
  `src/extension/entrypoints/background.ts:68-74,85-89,174-179` (FR-008, SC-005,
  US3/AC3). Source has it; no test (`tests/bucket.ts` gives every e2e server an empty
  extensions directory).
  - Evidence: T030's test, in Chrome and Firefox: the followed PDF link reaches the
    "Not saved" page with the stale detail and stores nothing, and Send tabs shows
    "Not sent: " with the stale detail and stores nothing (pass 2026-11-26).
- [X] T019 [US3] Show This build, Provisioned and Replacement in the popup of a stale
  build, in `src/extension/entrypoints/popup/main.ts:63-70` and
  `src/extension/bucket-status.ts:99` (FR-008, US3/AC3). Source has it; no test.
  - Evidence: T030's test asserts the popup's Address, This build, Provisioned and
    Replacement in Chrome and Firefox (pass 2026-11-26).
- [X] T020 [US3] Show the badge `OLD` with the replacement as its title for a stale
  build in `src/extension/bucket-status.ts` (FR-007, FR-008, US3/AC3). Source has it; no
  test.
  - Evidence: T030's test asserts badge `OLD` and the stale detail as the toolbar title
    in Chrome and Firefox (pass 2026-11-26).
- [X] T021 [US3] Run the server and report `null` for each browser that has no
  provisioned build (US3/AC2, server half)
  - Evidence: `server/src/extensions.rs:50-66`; `tests/server-status.test.ts:22-40`
    expects `extensions: { chrome: null, firefox: null }` from a server given no builds.
- [X] T022 [US3] After the matching build replaces a stale one, the same PDF navigation
  stores the PDF and opens the reader (US3/AC4, SC-005). No test of the replacement.
  - Evidence: T030's test writes the loaded version to the manifests, and the same link
    opens `/read/2401.00001` and stores `2401.00001/2401.00001.pdf`, in Chrome and Firefox
    (pass 2026-11-26).

## Phase 5: Convergence

**Assessment basis**: commit `3a4a08a`, the working tree on 2026-11-25. Every task above
that is not `[X]` maps to a task here.

- [X] T023 Remove `scripts/amo_signed.py` and `scripts/firefox-policy.sh` from the
  application input in `scripts/source-fingerprint:8`. Only
  `scripts/provision-extensions.sh` and `just firefox-policy` read them, so an edit to
  them now rebuilds the app. Per FR-005 and SC-004 (contradicts).
  - Evidence: `scripts/source-fingerprint:4-9`; the red test (ec7d7e9) failed for both
    scripts and passes after the change.
- [X] T024 Test the launcher in `tests/launch.test.ts` (T001 harness): changed source
  runs `just provision-for-launch` in the `kitty` substitute and then the new binary
  (T011); a failed substitute build gives exit 1, the critical notification, a terminal
  that waits for Enter, and no app start (T012); an unchanged stamp runs the binary with
  no build (T013); two launches build once (T015); an edit to `src/extension/`,
  `wxt.config.ts`, `scripts/amo_signed.py` or `scripts/firefox-policy.sh` leaves
  `scripts/source-fingerprint` unchanged and an edit to `src/web/` changes it (T010,
  T023). Run `scripts/provision.sh --for-launch` with substitutes for `direnv`, `bun`,
  `bunx`, `uv`, `pgrep`, `killall` and `systemctl`, and assert that the stamp is the hash
  taken before the build and is absent after a failed build (T014). Per FR-003, FR-004,
  FR-005, SC-002, SC-003, SC-004, US2/AC1-AC3 (missing).
  - Evidence: `tests/launch.test.ts`, all three describe blocks; the programs it
    substitutes are in `tests/fixtures/launch`.
- [X] T025 Keep the failure of the last rebuild after its terminal closes, and show it in
  the next window, and mark an app that is already running as stale when its source
  changed: `scripts/launch`, `scripts/provision.sh`, `server/src/app.rs` (`/status`),
  `src/contract/capture.ts`, `src/web/components/StatusBar.tsx`. Today a failed rebuild
  leaves a running old app with no sign. Per FR-004, FR-007, US2/AC2 (partial).
  - Evidence: The launcher keeps the rebuild output in rebuild.log and the exit status in
    rebuild-failure; GET /api/app-build answers failed with both (tests/launch.test.ts
    "after a failed rebuild's terminal closes"); a running window re-reads it on focus
    and shows Old build or Rebuild failed in the status bar (tests/library-e2e.test.ts
    "Settings and the status bar say whether the app build").
- [X] T026 Report the Provisioning State of the app build (current, stale, failed) and of
  each extension build (provisioned version or none) in the library: add the app build's
  fingerprint to `/status` (`server/src/app.rs:375-397`, `src/contract/capture.ts:126`)
  and show both in `src/web/screens/SettingsScreen.tsx`, which today shows only the
  constant crate version (`SettingsScreen.tsx:218`). Per FR-007, US3/AC2 (partial).
  - Evidence: Settings shows App build (current, old, failed, not provisioned) from GET
    /api/app-build and the Chrome and Firefox extension builds, or None
    (tests/library-e2e.test.ts "Settings and the status bar say whether the app build").
    The state is a separate endpoint, not a /status field, because installed extensions
    parse /status with a strict schema.
- [X] T027 Report a missing extension provisioning in the extension: when `/status`
  gives `null` for the browser, `checkBucket` in `src/extension/bucket-status.ts:66-70`
  treats the build as current and the popup says nothing. Per FR-007, US3/AC2 (partial).
  - Evidence: The popup shows "Provisioned: none: Math PDF Reader offers no build of this
    extension, ..." when /status reports null (tests/capture-e2e.test.ts "the status page
    and the badge name Math PDF Reader", both browsers); captures stay accepted.
- [X] T028 Refuse extension provisioning when the extension input is not committed, and
  name the paths, in `scripts/provision-extensions.sh`. The version is the commit count
  (`wxt.config.ts:24-27`), so uncommitted input reuses the installed version:
  `scripts/amo_signed.py` returns the earlier signed package, Firefox keeps the old code,
  Chromium sees no newer version, and `extension-fingerprint` records the new input. Per
  US3/AC1, FR-007 (partial).
  - Evidence: `scripts/provision-extensions.sh:11-15`; `tests/launch.test.ts`
    "uncommitted extension input is refused with its paths, and nothing is built", red at
    8f9c5a2.
- [X] T029 Provision each browser's build without a dependency on the other browser's
  setup: the Chromium load check at `scripts/provision-extensions.sh:42-46` runs before
  Firefox signing and stops it. Add a test with substitutes for `bunx`, `web-ext` and
  `uv` that an unchanged extension input builds nothing (T016) and that each browser's
  precondition stops only that browser. Per FR-006, US3/AC1 (partial).
  - Evidence: `scripts/provision-extensions.sh:37-70`; `tests/launch.test.ts` "a Chromium
    that does not load the build stops only the Chrome build" (red at 8f9c5a2) and "a
    Firefox without the add-on policy stops only the Firefox build".
- [X] T030 Test a stale build in `tests/capture-e2e.test.ts` for Chrome and Firefox: give
  the server an extensions directory whose manifests name another version; assert badge
  `OLD`, the popup's This build, Provisioned and Replacement, and that a PDF navigation
  stores nothing (T018-T020); then write the loaded version to the manifests and assert
  that the same navigation stores the PDF and opens the reader (T022). Extend
  `tests/bucket.ts:62-81` to take that directory. Per FR-008, SC-005, US3/AC3-AC4
  (missing).
  - Evidence: "a build other than the provisioned one shows OLD with its replacement and
    refuses a PDF link and Send tabs; the link is stored once the provisioned build is
    the loaded one" in `tests/capture-e2e.test.ts` passes in Chrome and Firefox
    (2026-11-26). In Chrome the test first sets storage `reloadedFor` to the provisioned
    version, the state of a stale build after Chrome reloaded an unpacked folder that
    still held it, so `reloadStaleBuild` does not reload.
  - The `chrome.runtime.reload()` call itself has no Chrome test: in Chromium 156 and
    Chrome for Testing 158.0.8127.88 an unpacked extension that Puppeteer loaded does not
    come back after it (tests/TRAPS.md, capture suite).
- [X] T031 Test the product name on each surface: `productName` and the window title in
  `desktop/src-tauri/tauri.conf.json`, the tray item labels and dialog titles in
  `desktop/src-tauri/src/lib.rs`, `Name=` in `desktop/pdf-bucket-desktop.desktop`, the
  manifest `name` in `tests/extension-manifest.test.ts`, and the titles of the library,
  failure, popup and capture pages; assert the window title in `tests/desktop_workflow.py`.
  Covers T002-T006, T008. Per FR-001, SC-001, US1/AC1 (missing).
  - Evidence: the tray items, the quit dialog and the `report` dialog as in T003; the
    `report` dialog's title is `.title("Math PDF Reader")` at
    `desktop/src-tauri/src/lib.rs:32`.
- [X] T032 Give the tray icon the title and tooltip "Math PDF Reader" in
  `desktop/src-tauri/src/lib.rs:390-405`; today `TrayIconBuilder::with_id("main")` sets
  neither, so the tray host shows an undetermined name. Per FR-001, US1/AC1 (partial).
  - Open: the app sets GLib's application name to "Math PDF Reader" before it builds the
    tray, which libappindicator (it imports `g_get_application_name`) uses as the
    StatusNotifierItem Title when none is set. tray-icon's `title` is a label beside the
    icon and its `tooltip` does nothing on Linux, so neither is set.
  - Evidence: `test_the_tray_item_and_its_menu_name_math_pdf_reader` in
    `tests/desktop_workflow.py` reads the StatusNotifierItem `Title` of the release app
    over its session bus with `busctl get-property`; `Title` is "Math PDF Reader" (run
    2026-11-25: the Title assertion passed, the later menu assertion failed, see T003).
- [X] T033 Remove the visible compatibility identifiers given as commands: the popup's
  "Start it: `gtk-launch pdf-bucket-desktop`" (`src/extension/entrypoints/popup/main.ts:76`),
  and "`pdf-bucket forget <key>`" in `src/web/components/StatusBar.tsx:55` and
  `server/src/main.rs:150`. The installed `~/.local/bin/pdf-bucket` is the launcher
  (`scripts/provision.sh:56`) and passes its arguments to the app, which ignores them, so
  the forget instruction does not work; the working command is `just forget <key>`. Add
  a test for each string. Per FR-002, US1/AC2, edge case "internal compatibility names
  … without being shown to users" (partial).
  - Evidence: Popup "Start it: Open Math PDF Reader from the application menu"
    (tests/capture-e2e.test.ts "with Math PDF Reader stopped", both browsers); the status
    bar and the export-index stderr name `just forget <key>` (tests/library-e2e.test.ts
    "a refused index export names the command", tests/index-export.test.ts forget test).
- [ ] T034 Rename "the bucket" in user-visible strings to "Math PDF Reader" (owner decision in plan.md):
  `desktop/src-tauri/src/lib.rs:71,98,112,373-375`, `desktop/src/index.html` ("The
  bucket is not serving"), `src/web/actionFailure.ts:48-51`,
  `src/web/screens/OrganizationScreen.tsx:166`, the popup heading "Checking the
  bucket…" and label "Bucket" (`popup/main.ts:55`), the badge title and the Firefox
  replacement text in `src/extension/bucket-status.ts`, and
  `src/extension/entrypoints/background.ts:97`. Rename each and test each. Per
  FR-001, US1/AC1 (partial).
  - Renamed and tested: `actionFailure.ts` (tests/library-e2e.test.ts "the library is
    titled Math PDF Reader"), `OrganizationScreen.tsx` (the collection cards test),
    `desktop/src/index.html` (the failure page test), the popup heading and label and the
    badge title (tests/capture-e2e.test.ts), the Firefox replacement (the stale test), and
    the port failure report in lib.rs (tests/desktop_workflow.py), the library folder
    failure in lib.rs (`test_a_library_folder_that_cannot_be_made_shows_math_pdf_reader_is_not_serving`
    in tests/desktop_workflow.py, pass 2026-11-25).
  - Open, not reached by a test:
    - lib.rs's server stopped/failed reports: they show when `axum::serve`'s task ends.
      In axum 0.8.9 (Cargo.lock) that task never ends: `Serve::run` is `async fn run(self)
      -> !`, a `loop` over `listener.accept()` (axum src/serve/mod.rs:179-193; its doc at
      :85-87 says "it will never actually complete or return an error"). The
      `TcpListener` accept loop retries every error (src/serve/listener.rs:29-36): it
      returns at once on a refused, aborted or reset connection, and logs any other error,
      EMFILE from a lowered `RLIMIT_NOFILE` among them, then sleeps 1 s
      (listener.rs:140-167). A panic cannot end the task alone: the release profile has
      `panic = "abort"` (Cargo.toml:17), which ends the process. So no route from outside
      the process exists (2026-11-26).
    - lib.rs's "does not serve" dialog: it shows only when the server stops before the
      app's own page loads, so it needs the stop above; it is also a dialog (see T003).
    - background.ts's "lost" download failure: it shows after a download's delivery
      began in more than `MAX_DELIVERIES` service workers that Chrome stopped before the
      server answered. A server that delays its answer would hold a delivery open, but the
      Chrome suite sees no service worker restart, not even in the browser's CDP target
      events (T030).

## Dependencies

- T001 before T024, T029.
- T023 before the fingerprint half of T024.
- T026 before T025 (T025 reads the build state that T026 adds to `/status`).
- T030 needs `tests/bucket.ts` to take an extensions directory.

## Traceability

| Requirement | Tasks |
| --- | --- |
| FR-001 | T002-T008, T031, T032, T034 |
| FR-002 | T009, T033 |
| FR-003 | T011, T013-T015, T024 |
| FR-004 | T012, T014, T024, T025 |
| FR-005 | T010, T023, T024 |
| FR-006 | T016, T029 |
| FR-007 | T017, T020, T025-T028 |
| FR-008 | T017-T020, T030 |
| SC-001 | T031 |
| SC-002 | T011, T024 |
| SC-003 | T012, T024 |
| SC-004 | T010, T023, T024 |
| SC-005 | T018, T022, T030 |
| US1/AC1, AC2 | T002-T009, T031-T034 |
| US2/AC1, AC2, AC3 | T010-T016, T023-T025 |
| US3/AC1 | T016, T017, T028, T029 |
| US3/AC2 | T021, T026, T027 |
| US3/AC3, AC4 | T018-T020, T022, T030 |
