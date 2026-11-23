# Quickstart: Assistant Paper Sources and Page Context

## Focused verification

Prerequisites: repository dependencies are installed and the Rust test binary has been
built by the normal test preload.

```bash
bun test tests/server-ai.test.ts --timeout 30000
cargo check --manifest-path server/Cargo.toml
```

Expected results:

- A session opens with no extraction and names the stored PDF and raw-page route.
- Raw page 2 contains page 2's known lecture sentence and exactly one page marker.
- Missing and out-of-range pages are explicit client errors.
- `/api/ai/text/{key}` remains extraction-only.
- An extraction run updates an already-open session's workspace and reader-view entry.
- An extraction run does not start an unused assistant.

## Real-provider regression

The shell environment must not override the configured provider credentials or model.
The test reads the configured model, creates an isolated bucket and private OpenCode
server, and captures the existing no-extraction PDF fixture.

```bash
just test-assistant-live
```

Expected results:

- The bucket has no structured extraction for the fixture.
- The assistant requests `/api/ai/pdf-text/long-notes?page=2` through the real bucket
  HTTP boundary.
- The visible assistant answer quotes: "The lattice Z2 has determinant 1 and 2 · 2
  vectors of norm 1."
- The answer contains no inability or extraction refusal.

## Provisioned application

After focused checks pass:

```bash
just provision
```

In the app on port 8770, open a PDF without an extraction and open its assistant. Ask
for text from a non-first page. The answer must identify the requested page's content.
`GET /api/ai/text/{key}` must continue to report no structured extraction for that
item. Run an extraction with the assistant open and verify that subsequent questions
can use the new extraction context without closing and reopening the pane.
