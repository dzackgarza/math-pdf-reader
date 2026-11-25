# Data Model: Assistant Document Directory

## Document Directory

- Identity: validated `Key`.
- Path: `<root>/<key>/`.
- Contains the current PDF and all current paper-specific artifacts.
- Does not contain extraction staging, store-wide filing or OpenCode session data.
- Creation: first PDF commit or legacy-layout migration.
- Deletion: the complete directory moves to desktop trash when the item is removed.

## Current PDF

- Path: `<root>/<key>/<key>.pdf`.
- Required for a stored item. Missing or unreadable PDFs fail explicitly.
- Contains its PDF URL, capture time and original SHA-256 internally. An explicit
  arXiv promotion replaces this PDF under the same key and embeds the captured
  provenance as historical lineage.
- Replacement keeps the same path and key, and retains annotation-save conflict checks.

## Complete Extraction

- Markdown: `<root>/<key>/<key>.md`; existence marks completion.
- Artifacts: `<root>/<key>/<key>.extraction/`.
- Metadata remains in the artifact directory as `metadata.json`.
- LaTeX source remains authoritative for arXiv extraction; the single derived Markdown file is the reading copy for that source.
- Validation occurs in hidden root staging. The artifact directory swaps in first and
  Markdown last. Each swap is atomic, so a reader never finds a missing part; the
  displaced previous outputs then move to trash.

## Arbitrary Paper Artifact

- Any additional current file below the document directory.
- Requires no schema registration or assistant-permission change.
- Is discoverable by an existing assistant session on a later turn.
- Is not automatically promoted to an authoritative extraction.

## Assistant Session

- The chat mapping pairs a session ID with the captured paper's provenance. A key
  can be reused after deletion, so the key alone cannot identify a conversation.
- `location.directory` equals the absolute document-directory path.
- A session bound to the same paper retains its ID when it moves to that directory.
- `reader-view` supplies exact page and optional search hint, not a catalog of
  extraction or metadata files.

## Legacy Flat Record

Recognized paths are `<root>/<key>.pdf`, `<root>/<key>.md` and
`<root>/<key>.extraction/`. Startup moves each to the corresponding document-directory
path. Each move requires a free destination name. A dangling symlink occupies its
name even when its target is missing. A collision preserves both entries and reports
their paths. After a partial move, the next start moves only remaining sources.

## Invariants

1. Every stored item has exactly one current PDF path and document directory.
2. Raw PDF reading has no extraction prerequisite.
3. Complete artifacts enrich the current PDF and do not replace it.
4. Incomplete enrichment is not in the document directory.
5. Item keys, reader/PDF URLs, embedded provenance and PDF bytes survive flat-store migration.
6. No synthetic workspace holds current copies or catalogs of paper artifacts.

## Edition transitions

| Operation | Current PDF at the library key | Chat on next open |
|---|---|---|
| Successful replacement | arXiv PDF with its own embedded provenance | Fresh chat bound to the arXiv edition |
| Failed replacement | Captured PDF | Existing captured-edition chat |
| Repeat selection of the current arXiv version | Same arXiv PDF | Existing arXiv-edition chat |
| Completed extraction | Same PDF, with new reading material | Same chat can read the published passage |
