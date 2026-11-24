# Quickstart: Assistant Paper Sources and Page Context

## Focused verification

Prerequisites: repository dependencies are installed and the Rust test binary has been
built by the normal test preload.

```bash
bun test tests/server-ai.test.ts --timeout 30000
cargo check --manifest-path server/Cargo.toml
```

Expected results:

- A session opens in the paper's document directory with no extraction.
- An existing session moves there without changing its session ID.
- Raw page 2 contains page 2's known lecture sentence and exactly one page marker.
- Missing and out-of-range pages are explicit client errors.
- The generic permissions permit direct reads of newly discovered paper artifacts.
- An extraction run places files in the same directory without changing the chat's
  source instructions or starting an unused assistant.

## Real-provider regression

The shell environment must not override the configured provider credentials or model.
The test reads the configured model, creates an isolated bucket and private OpenCode
server, and captures the existing no-extraction PDF fixture.

```bash
just test-assistant-live
```

The check asks for a sentence on raw page 2 and verifies the assistant's answer and its
request to `GET /api/ai/pdf-text/{key}?page=2`. It then writes a unique, unregistered
artifact into the same paper directory, asks for its marker in the same chat, and
requires a completed direct read of that artifact. No request to a removed
extraction-text endpoint is valid evidence.

## Provisioned verification

Run `just provision`, then use the assistant on port 8770. Ask `0002066v1` for the
page-2 sentence beginning `E =`. The answer must identify the Eisenstein integers from
the raw original PDF. Add a unique text artifact to an enriched paper's document
directory and ask for its marker in the existing chat. The same chat must read the new
file and answer with its marker.
