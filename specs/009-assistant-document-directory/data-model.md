# Data Model: Assistant Document Directory

## Document Directory

- Identity: validated `Key`.
- Path: `<root>/<key>/`.
- Contains the original PDF and all current paper-specific artifacts.
- Does not contain extraction staging, store-wide filing or OpenCode session data.
- Creation: first PDF commit or legacy-layout migration.
- Deletion: the complete directory moves to desktop trash when the item is removed.

## Original Document

- Path: `<root>/<key>/<key>.pdf`.
- Required for a stored item. Missing or unreadable originals fail explicitly.
- Contains the PDF URL, capture time and original SHA-256 internally.
- Replacement keeps the same path and key, and retains annotation-save conflict checks.

## Complete Extraction

- Markdown: `<root>/<key>/<key>.md`; existence marks completion.
- Artifacts: `<root>/<key>/<key>.extraction/`.
- Metadata remains in the artifact directory as `metadata.json`.
- LaTeX source remains authoritative for arXiv extraction; the single derived Markdown file is the reading copy for that source.
- Validation occurs in hidden root staging. The artifact directory moves first and
  Markdown last after previous complete outputs move to trash.

## Arbitrary Paper Artifact

- Any additional current file below the document directory.
- Requires no schema registration or assistant-permission change.
- Is discoverable by an existing assistant session on a later turn.
- Is not automatically promoted to an authoritative extraction.

## Assistant Session

- One persistent OpenCode session ID per key in the existing chat mapping.
- `location.directory` equals the absolute document-directory path.
- Existing sessions retain their ID and move to that directory.
- `reader-view` supplies exact page and optional search hint, not a catalog of
  extraction or metadata files.

## Legacy Flat Record

Recognized paths are `<root>/<key>.pdf`, `<root>/<key>.md` and
`<root>/<key>.extraction/`. Startup moves each to the corresponding document-directory
path. It refuses to overwrite any existing destination. After a partial move, the next
start moves only remaining sources.

## Invariants

1. Every stored item has exactly one original path and document directory.
2. Raw PDF reading has no extraction prerequisite.
3. Complete artifacts enrich the original and do not replace it.
4. Incomplete enrichment is not in the document directory.
5. Item keys, reader/PDF URLs, embedded provenance and original bytes survive migration.
6. No synthetic workspace holds current copies or catalogs of paper artifacts.
