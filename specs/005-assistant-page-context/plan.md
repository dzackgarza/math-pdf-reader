# Implementation plan: assistant page context

## Design

OpenCode owns file discovery, tool choice and reading. The bucket sets the session
location and updates the displayed page number when the reader reports it. A short
text-layer snippet can help locate the passage in a complete extraction. The
assistant checks the passage against a paper artifact.

## Implementation owners

- `server/src/ai.rs` owns session location, tool permissions and reader context.
- Extraction commands place their completed files through the store's existing
  extraction contract. See [source discovery](../004-extraction-source-discovery/spec.md).
- `tests/server-ai.test.ts` and `tests/server-ai-live.ts` exercise the HTTP and
  provider boundaries. The [validation guide](quickstart.md) specifies the
  required observations.
