# Quickstart: Capture and Provenance Validation

## Prerequisites

- Bun dependencies installed.
- Rust toolchain available.
- The local Math PDF Reader server and desktop launcher configured.
- Chrome and Firefox capture builds available for browser fixture tests.

## Focused automated checks

```bash
bun test tests/capture-e2e.test.ts tests/server-sources.test.ts tests/extension-manifest.test.ts
bun run typecheck
cargo test --workspace
python -m pytest tests/test_titles.py
```

Expected result: eligible Chrome and Firefox fixtures capture through equivalent
contracts; ineligible requests remain native; failures expose native-open actions;
embedded provenance survives reindexing; source rebuild tries the original URL
before mirrors and rejects mismatched bytes.

## Manual browser checks

1. Start the normal app launcher.
2. Navigate to a PDF fixture in Chrome and Firefox.
3. In a Wayland session, verify the paper opens at a stable local reader URL and
   the desktop window is raised, or that an actionable focus failure is shown.
   Focus behavior in non-Wayland sessions is outside this feature's scope.
4. Repeat with capture disabled and verify the browser remains native while status
   shows capture is disabled.
5. Exercise a non-PDF response, a POST, a small embedded frame, and a bucket-origin
   URL; verify none is intercepted.
6. Stop or make the bucket unavailable, capture a PDF, and verify the error page
   offers **Open in the browser**.
7. Mark a captured paper Needs Re-fetch, remove its local bytes, and verify rebuild
   attempts the original URL before mirrors and retains the record on failure.

## Evidence to record

- Browser and fixture used.
- Capture response and reader URL.
- Embedded provenance fields and original SHA-256.
- Visible failure text and native-open result.
- Recovery attempt order and final state.
- Wayland focus result or explicit focus failure.
