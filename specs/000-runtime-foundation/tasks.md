---
description: "Task list for Math PDF Reader Runtime Foundation"
---

# Tasks: Math PDF Reader Runtime Foundation

**Input**: Design documents from `specs/000-runtime-foundation/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/runtime.md](contracts/runtime.md),
[quickstart.md](quickstart.md)

**Tests**: The spec's acceptance scenarios and success criteria are smoke tests of the
real app, so each story has real-boundary tests. A task is `[X]` only when the
implementing code and a test that exercises it through its real path both exist. The
indented evidence line names both.

The behaviour was built before this spec. On 2026-11-25 these tests passed on the
current source: `tests/server-capture.test.ts` ("served at its PDF URL", "name no
stored PDF"), `tests/library-e2e.test.ts` ("reader link button copies", "reader
records the last viewed page"), and `tests/desktop_workflow.py::test_wheel_reading_keeps_position`
on a fresh release build. Other cited tests were read but not run in this session.

## Phase 1: Setup

- [X] T001 Drive the release app through its own window on headless Weston under
  WebKitWebDriver, in a private network namespace, in `tests/desktop_workflow.py` and
  the `test-desktop` recipe in `justfile`
  - Evidence: harness `tests/desktop_workflow.py:65-140`, `justfile:107-110`; run
    `test_wheel_reading_keeps_position` passed.

## Phase 2: Foundational

- [X] T002 Bind the bucket's port in the app's own process before the window loads, in
  `start()` in `desktop/src-tauri/src/lib.rs` and `serve()` in `server/src/lib.rs`
  - Evidence: code `desktop/src-tauri/src/lib.rs:118-134`, `server/src/lib.rs:48-69`;
    test `tests/desktop_workflow.py:137-140` waits until the window is at `ORIGIN`.
- [X] T003 Derive the PDF and reader addresses from the key alone and route them in
  `server/src/reader.rs` and `server/src/app.rs`
  - Evidence: code `server/src/reader.rs:9-15`, `server/src/app.rs:462-463`; test
    `tests/server-capture.test.ts:54-86` (local `reader_url`, `/pdf/<key>.pdf`),
    `tests/server-capture.test.ts:108-121` (404 for unknown and encoded-traversal keys).

## Phase 3: User Story 1 - Open the reader workspace (P1, MVP)

**Goal**: The launched app shows the library and reader tabs. Each stored PDF renders
in a tab and has a stable local reader address that survives reload and revisit.

**Independent Test**: Launch the release app, open one known PDF, then load and reload
its reader address.

- [X] T004 [US1] Open the window on the app's own page, then go to the bucket origin's
  library, in `desktop/src-tauri/src/lib.rs` (US1/AC1, FR-001)
  - Evidence: code `desktop/src-tauri/src/lib.rs:279-341`; test
    `tests/desktop_workflow.py:137-140`.
- [X] T005 [US1] Open a captured PDF's reader in a tab of the window from the
  `open-reader` event, and render it, in `server/src/events.rs`, `src/web/tabs.tsx` and
  `desktop/src-tauri/src/follow-open-events.js` (US1/AC2, FR-001, FR-003)
  - Evidence: code `server/src/events.rs:36-40`, `src/web/tabs.tsx:209-211`,
    `desktop/src-tauri/src/follow-open-events.js:41-49`; tests
    `tests/desktop_workflow.py:143-177` (`capture` waits for the active tab and a drawn
    PDF), `tests/desktop_workflow.py:204-222`, `tests/server-events.test.ts:14-50`.
- [X] T006 [US1] Open a stored PDF from the library table in a reader tab, in
  `src/web/Workspace.tsx` and `src/web/tabs.tsx` (FR-003)
  - Evidence: code `src/web/Workspace.tsx:307`; test `open_from_library` in
    `tests/desktop_workflow.py:633-654`, used by `test_a_reading_session`
    (`tests/desktop_workflow.py:724`); not run in this session.
- [X] T007 [US1] Serve every stored PDF's bytes at `/pdf/<key>.pdf` and its reader page
  at `/read/<key>`, including PDFs imported or present at startup, in
  `server/src/app.rs` (FR-002, US1/AC2)
  - Evidence: code `server/src/app.rs:402-451`; tests
    `tests/server-capture.test.ts:71-85`, `tests/server-import.test.ts:160-165`.
- [X] T008 [US1] Show the same paper, at its recorded page, when `/read/<key>` is
  revisited while the server runs, in `src/web/reader/main.tsx` (US1/AC3, FR-003)
  - Evidence: code `src/web/reader/main.tsx:39-49`, `server/src/app.rs:439-451`; tests
    `tests/library-e2e.test.ts:2215-2246`, `tests/library-e2e.test.ts:2011-2023`.
- [X] T009 [US1] Keep the local reader and PDF addresses apart from the original PDF
  URL: local `reader_url`, `pdf_url` and `citation_pdf_url`; the original only in
  `provenance.pdf_url`, which Copy PDF link copies, in `src/contract/capture.ts` and
  `src/web/reader/commands.ts` (FR-005)
  - Evidence: code `src/contract/capture.ts:8-13,55-62`,
    `src/web/reader/commands.ts:103-112`; tests `tests/server-capture.test.ts:68,80-85`
    (local addresses while the source is `https://www.math.example.edu/...`),
    `tests/library-e2e.test.ts:1337-1350` (the copied link is the published URL).
- [X] T010 [US1] Load the capture's `reader_url` in the desktop window, reload it, and
  verify that the same paper renders, in `tests/desktop_workflow.py` (SC-002, US1
  independent test)
  - Evidence: test `tests/desktop_workflow.py:1838`
    (`test_a_captured_reader_address_draws_its_pdf_in_the_window_and_again_after_reload`).
    Run 2026-11-26 on a fresh release build: passed. See T019.

## Phase 4: User Story 2 - Surface startup failure (P1)

**Goal**: A failed build or a bucket that cannot serve is visible. The app never starts
an old build and the window never stays blank.

**Independent Test**: Run the launcher with a failing rebuild, and start the app with
the port taken and with no web bundle. Each case shows an actionable failure.

- [X] T011 [US2] Stop the launch when the rebuild fails: message on stderr, critical
  notification, exit 1, installed binary not started, in `scripts/launch` (US2/AC1,
  FR-004, SC-003)
  - Evidence: code `scripts/launch:8-12,35-39`; tests `tests/launch.test.ts:188-208`
    (the build terminal waits for Enter, critical notification, exit 1, no app start),
    `tests/launch.test.ts:210-236` (the failure stays readable at `/api/app-build` after
    the terminal closes). Run 2026-11-26: the first passed.
- [X] T012 [US2] Rebuild before start when the stamp differs from
  `scripts/source-fingerprint` or is absent, and write the stamp last, in
  `scripts/launch` and `scripts/provision.sh` (FR-004: no stale startup)
  - Evidence: code `scripts/launch:35-42`, `scripts/provision.sh:14,73`; tests
    `tests/launch.test.ts:160-175` (no app, then a source edit: rebuild, then the new
    build starts), `tests/launch.test.ts:177-186` (unchanged source: no rebuild),
    `tests/launch.test.ts:261-276` (the stamp is the hash of the built source),
    `tests/launch.test.ts:278-285` (a failed build writes no stamp). Run 2026-11-26: all
    four passed.
- [X] T013 [US2] Show "Math PDF Reader is not serving" and the report on the window's own
  page when `start()` fails, in `desktop/src-tauri/src/lib.rs` and
  `desktop/src/index.html` (US2/AC2, FR-004, SC-001, SC-003)
  - Evidence: code `desktop/src-tauri/src/lib.rs:122-136`, `desktop/src/index.html`;
    tests `tests/desktop_workflow.py:1472` (port taken, shipped by 007),
    `tests/desktop_workflow.py:1791` (library folder, shipped by 007),
    `tests/desktop_workflow.py:1814` (missing library page). See T017.
- [X] T014 [US2] Name, in each `StartFailure` report, the cause and a remedy that
  repairs it, in `desktop/src-tauri/src/lib.rs` (US2/AC2: actionable)
  - Evidence: code `desktop/src-tauri/src/lib.rs:91-118`; `NoWebBundle` now names
    `just provision` (T018); test `tests/desktop_workflow.py:1814`.

## Phase 5: Polish and cross-cutting

- [ ] T015 After T016-T019, run `just provision` and do the installed checks in
  `specs/000-runtime-foundation/quickstart.md` on port 8770: library at launch, one PDF
  in a tab, reader address reload, Copy PDF link, failed rebuild, and port taken
  (constitution Development Workflow)

## Dependencies & Execution Order

- T001-T003 precede every story task.
- US1 (T004-T010) and US2 (T011-T014) are independent. Both use the T001 harness.
- T016 and T017 come before the fix in T018, and must fail first on the current code
  where they cover a defect.
- T015 follows all other tasks.

## Parallel Opportunities

- T016 (`tests/launch.test.ts`) and T017/T019 (`tests/desktop_workflow.py`) touch
  different files.
- T017 and T019 share `tests/desktop_workflow.py`; do them in sequence.

## Implementation Strategy

US1 is in place. Its remaining item is the reader-address reload in the window
(T019). For US2, write the launcher and window failure tests first (T016, T017). Then
correct the one wrong remedy (T018) and verify the installed app (T015).

## Phase 6: Convergence

- [X] T016 [US2] Run `scripts/launch` itself with a scratch `HOME` and
  `XDG_DATA_HOME`, a marker binary, and stubs for `kitty`, `just` and `notify-send`.
  Cover a failed rebuild, a current stamp and a stale stamp. Per US2/AC1, FR-004 and
  SC-003 (missing).
  - Evidence: feature 007 shipped this test as `tests/launch.test.ts`.
    `launcherCheckout` (`tests/launch.test.ts:99-106`) runs the checkout's
    `scripts/launch` with `tests/fixtures/launch/bin` first on `PATH`. See T011 and T012
    for the cases and runs.
- [X] T017 [US2] Add start-failure cases to `tests/desktop_workflow.py`, in the
  `just test-desktop` namespace. (a) Hold the configured port on 127.0.0.1, then start
  the release app. The window must not reach `ORIGIN`. Its body must contain "Math PDF
  Reader is not serving", the origin and the OS bind error. (b) Leave `dist/web` out of the
  scratch runtime. The body must name the missing `index.html` path and `just provision`.
  Per US2/AC2, FR-004, SC-001 and SC-003 (missing).
  - Evidence: (a) feature 007 shipped
    `test_a_port_already_taken_shows_math_pdf_reader_is_not_serving_in_its_window`
    (`tests/desktop_workflow.py:1472`); run 2026-11-26 on a fresh release build: passed.
    (b) `test_a_missing_library_page_shows_math_pdf_reader_is_not_serving_and_names_just_provision`
    (`tests/desktop_workflow.py:1814`), committed red in e41b6c8: the report said
    "run `just build-web`".
- [X] T018 [US2] Change the `NoWebBundle` report in `desktop/src-tauri/src/lib.rs:102-106`
  to name `just provision`. The installed app reads
  `$XDG_DATA_HOME/pdf-bucket-app/dist/web` (`server/src/config.rs:84-86`). Only
  `scripts/provision.sh` writes that copy; `just build-web` writes the checkout's
  `dist/web`. Commit the failing T017(b) first. Per US2/AC2 and T014 (contradicts).
  - Evidence: the report reads "Math PDF Reader is missing its library page <path>; run
    `just provision` to install it."; T017(b) passed on the rebuilt release app.
- [X] T019 [US1] Make `capture` in `tests/desktop_workflow.py` return the capture
  response. Add a test that navigates the window to its `reader_url` and waits for the
  key's reader to draw. Then reload the window and wait again. Check that
  `reader_url` is on `ORIGIN` and differs from `provenance.pdf_url`. Per SC-002, US1/AC2,
  US1/AC3 and T010 (partial).
  - Evidence: `post_capture` (`tests/desktop_workflow.py:151`) returns the response and
    `capture` uses it. The test at `tests/desktop_workflow.py:1838` checks the published
    URL in `provenance.pdf_url`, `reader_url` as `ORIGIN/read/<key>`, and the drawn PDF
    of the key before and after a reload. Run 2026-11-26: passed.
