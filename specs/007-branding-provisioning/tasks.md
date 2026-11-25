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

- [ ] T001 Add `tests/launch.test.ts` with a scratch git worktree of the checkout, scratch
  `HOME`, `XDG_DATA_HOME` and `XDG_CONFIG_HOME`, and recording substitutes on `PATH` for
  `kitty`, `notify-send`, `just` and `~/.local/bin/pdf-bucket-desktop`
  (research.md R6)

## Phase 2: User Story 1 - One product identity (P1)

**Goal**: Every surface the user sees names the product Math PDF Reader.

**Independent Test**: Open each surface and read its name (quickstart.md US1).

- [ ] T002 [P] [US1] Name the window and the product "Math PDF Reader" in
  `desktop/src-tauri/tauri.conf.json` (FR-001, US1/AC1). Source has it; no test.
- [ ] T003 [P] [US1] Name the dialogs and the tray items "Math PDF Reader" in
  `desktop/src-tauri/src/lib.rs:32,154,383-384` (FR-001, US1/AC1). Source has it; no
  test.
- [ ] T004 [P] [US1] Name the launcher and autostart entry `Name=Math PDF Reader` in
  `desktop/pdf-bucket-desktop.desktop` (FR-001, US1/AC1). Source has it; no test.
- [ ] T005 [P] [US1] Name both extensions "Math PDF Reader" in `wxt.config.ts:41`
  (FR-001, US1/AC1). Source has it; `tests/extension-manifest.test.ts` checks only the
  permissions.
- [ ] T006 [P] [US1] Title the library, the window failure page, the popup and the
  capture page "Math PDF Reader" in `src/web/index.html`, `desktop/src/index.html`,
  `src/extension/entrypoints/popup/index.html`, `src/extension/entrypoints/capture/index.html`
  (FR-001, US1/AC1). Source has it; no test.
- [X] T007 [US1] Name Math PDF Reader in the popup's report of a foreign service on the
  bucket's port (FR-001, US1/AC1)
  - Evidence: `src/extension/bucket-status.ts:63-64`;
    `tests/capture-e2e.test.ts:954-966` asserts "not a Math PDF Reader status report" in
    `#connection-details` of each browser's popup.
- [ ] T008 [US1] Name Math PDF Reader in the rebuild terminal title and in the launcher
  notifications in `scripts/launch:14,21,38,40` (FR-001, US1/AC1). Source has it; no
  test.
- [ ] T009 [US1] Show no compatibility identifier as the product name or as a command
  to run on any surface (FR-002, US1/AC2). Partial: see T033.

## Phase 3: User Story 2 - Launch the current build (P1)

**Goal**: A launch never opens an app older than its source.

**Independent Test**: quickstart.md US2.

- [ ] T010 [US2] Exclude `src/extension/**` and `wxt.config.ts` from the application
  input in `scripts/source-fingerprint:7-12` (FR-005, SC-004, US2/AC3). Source has it;
  no test. Contradicted for two scripts: see T023.
- [ ] T011 [US2] Rebuild before the launch when the binary or the stamp is missing or the
  stamp differs, then start the new build, in `scripts/launch:37-44` (FR-003, SC-002,
  US2/AC1). Source has it; no test.
- [ ] T012 [US2] On a failed rebuild, keep the output in the terminal, send a critical
  notification, exit 1 and start no app, in `scripts/launch:12-32,39-40` (FR-004,
  SC-003, US2/AC2). Source has it; no test.
- [ ] T013 [US2] With an unchanged stamp, start the installed binary with no rebuild in
  `scripts/launch:37,44` (FR-003). Source has it; no test.
- [ ] T014 [US2] Hash the input before the build and write the stamp as the last install
  step in `scripts/provision.sh:14,73` (FR-003, FR-004). Source has it; no test.
- [ ] T015 [US2] Serialize two concurrent launches with the lock in
  `scripts/launch:34-36,42`, so a second launch does not start the old build while the
  first rebuilds (FR-003). Source has it; no test.

## Phase 4: User Story 3 - Separate browser integrations (P2)

**Goal**: Extension builds are provisioned on their own, and a mismatched build refuses
captures and names its replacement.

**Independent Test**: quickstart.md US3.

- [ ] T016 [US3] Keep extension provisioning a separate explicit recipe that does nothing
  when its input is unchanged: `justfile:43-45`, `scripts/provision-extensions.sh:12-18`;
  `scripts/provision.sh` builds no extension (FR-006, US2/AC3, US3/AC1). Source has it;
  no test.
- [X] T017 [US3] Report each provisioned extension version at `/status` and serve the
  signed Firefox build with its update manifest (FR-007, FR-008, US3/AC1)
  - Evidence: `server/src/extensions.rs:50-70,87-116`, `server/src/app.rs:375-397`;
    `tests/server-status.test.ts:93-134` (versions, `updates.json` hash and link,
    `firefox.xpi` bytes and type), `tests/server-status.test.ts:136-148` (404 with no
    signed build).
- [ ] T018 [US3] Refuse every capture and Send tabs from a build whose version differs
  from the provisioned one, in `src/extension/bucket-status.ts:66-70` and
  `src/extension/entrypoints/background.ts:68-74,85-89,174-179` (FR-008, SC-005,
  US3/AC3). Source has it; no test (`tests/bucket.ts` gives every e2e server an empty
  extensions directory).
- [ ] T019 [US3] Show This build, Provisioned and Replacement in the popup of a stale
  build, in `src/extension/entrypoints/popup/main.ts:63-70` and
  `src/extension/bucket-status.ts:99` (FR-008, US3/AC3). Source has it; no test.
- [ ] T020 [US3] Show the badge `OLD` with the replacement as its title for a stale
  build in `src/extension/bucket-status.ts` (FR-007, FR-008, US3/AC3). Source has it; no
  test.
- [X] T021 [US3] Run the server and report `null` for each browser that has no
  provisioned build (US3/AC2, server half)
  - Evidence: `server/src/extensions.rs:50-66`; `tests/server-status.test.ts:22-40`
    expects `extensions: { chrome: null, firefox: null }` from a server given no builds.
- [ ] T022 [US3] After the matching build replaces a stale one, the same PDF navigation
  stores the PDF and opens the reader (US3/AC4, SC-005). No test of the replacement.

## Phase 5: Convergence

**Assessment basis**: commit `3a4a08a`, the working tree on 2026-11-25. Every task above
that is not `[X]` maps to a task here.

- [ ] T023 Remove `scripts/amo_signed.py` and `scripts/firefox-policy.sh` from the
  application input in `scripts/source-fingerprint:8`. Only
  `scripts/provision-extensions.sh` and `just firefox-policy` read them, so an edit to
  them now rebuilds the app. Per FR-005 and SC-004 (contradicts).
- [ ] T024 Test the launcher in `tests/launch.test.ts` (T001 harness): changed source
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
- [ ] T025 Keep the failure of the last rebuild after its terminal closes, and show it in
  the next window, and mark an app that is already running as stale when its source
  changed: `scripts/launch`, `scripts/provision.sh`, `server/src/app.rs` (`/status`),
  `src/contract/capture.ts`, `src/web/components/StatusBar.tsx`. Today a failed rebuild
  leaves a running old app with no sign. Per FR-004, FR-007, US2/AC2 (partial).
- [ ] T026 Report the Provisioning State of the app build (current, stale, failed) and of
  each extension build (provisioned version or none) in the library: add the app build's
  fingerprint to `/status` (`server/src/app.rs:375-397`, `src/contract/capture.ts:126`)
  and show both in `src/web/screens/SettingsScreen.tsx`, which today shows only the
  constant crate version (`SettingsScreen.tsx:218`). Per FR-007, US3/AC2 (partial).
- [ ] T027 Report a missing extension provisioning in the extension: when `/status`
  gives `null` for the browser, `checkBucket` in `src/extension/bucket-status.ts:66-70`
  treats the build as current and the popup says nothing. Per FR-007, US3/AC2 (partial).
- [ ] T028 Refuse extension provisioning when the extension input is not committed, and
  name the paths, in `scripts/provision-extensions.sh`. The version is the commit count
  (`wxt.config.ts:24-27`), so uncommitted input reuses the installed version:
  `scripts/amo_signed.py` returns the earlier signed package, Firefox keeps the old code,
  Chromium sees no newer version, and `extension-fingerprint` records the new input. Per
  US3/AC1, FR-007 (partial).
- [ ] T029 Provision each browser's build without a dependency on the other browser's
  setup: the Chromium load check at `scripts/provision-extensions.sh:42-46` runs before
  Firefox signing and stops it. Add a test with substitutes for `bunx`, `web-ext` and
  `uv` that an unchanged extension input builds nothing (T016) and that each browser's
  precondition stops only that browser. Per FR-006, US3/AC1 (partial).
- [ ] T030 Test a stale build in `tests/capture-e2e.test.ts` for Chrome and Firefox: give
  the server an extensions directory whose manifests name another version; assert badge
  `OLD`, the popup's This build, Provisioned and Replacement, and that a PDF navigation
  stores nothing (T018-T020); then write the loaded version to the manifests and assert
  that the same navigation stores the PDF and opens the reader (T022). Extend
  `tests/bucket.ts:62-81` to take that directory. Per FR-008, SC-005, US3/AC3-AC4
  (missing).
- [ ] T031 Test the product name on each surface: `productName` and the window title in
  `desktop/src-tauri/tauri.conf.json`, the tray item labels and dialog titles in
  `desktop/src-tauri/src/lib.rs`, `Name=` in `desktop/pdf-bucket-desktop.desktop`, the
  manifest `name` in `tests/extension-manifest.test.ts`, and the titles of the library,
  failure, popup and capture pages; assert the window title in `tests/desktop_workflow.py`.
  Covers T002-T006, T008. Per FR-001, SC-001, US1/AC1 (missing).
- [ ] T032 Give the tray icon the title and tooltip "Math PDF Reader" in
  `desktop/src-tauri/src/lib.rs:390-405`; today `TrayIconBuilder::with_id("main")` sets
  neither, so the tray host shows an undetermined name. Per FR-001, US1/AC1 (partial).
- [ ] T033 Remove the visible compatibility identifiers given as commands: the popup's
  "Start it: `gtk-launch pdf-bucket-desktop`" (`src/extension/entrypoints/popup/main.ts:76`),
  and "`pdf-bucket forget <key>`" in `src/web/components/StatusBar.tsx:55` and
  `server/src/main.rs:150`. The installed `~/.local/bin/pdf-bucket` is the launcher
  (`scripts/provision.sh:56`) and passes its arguments to the app, which ignores them, so
  the forget instruction does not work; the working command is `just forget <key>`. Add
  a test for each string. Per FR-002, US1/AC2, edge case "internal compatibility names
  … without being shown to users" (partial).
- [ ] T034 Decide whether "the bucket" in user-visible strings is the old product name:
  `desktop/src-tauri/src/lib.rs:71,98,112,373-375`, `desktop/src/index.html` ("The
  bucket is not serving"), `src/web/actionFailure.ts:48-51`,
  `src/web/screens/OrganizationScreen.tsx:166`, the popup heading "Checking the
  bucket…" and label "Bucket" (`popup/main.ts:55`), the badge title and the Firefox
  replacement text in `src/extension/bucket-status.ts`, and
  `src/extension/entrypoints/background.ts:97`. If yes, rename them and test each. Per
  FR-001, US1/AC1 (partial; blocked on the owner question in plan.md).

## Dependencies

- T001 before T024, T029.
- T023 before the fingerprint half of T024.
- T026 before T025 (T025 reads the build state that T026 adds to `/status`).
- T030 needs `tests/bucket.ts` to take an extensions directory.
- T034 waits on the owner.

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
