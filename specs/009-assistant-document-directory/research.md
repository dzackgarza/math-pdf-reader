# Research: Assistant Document Directory

## Storage boundary

**Decision**: Use `<root>/<key>/<key>.pdf`, `<root>/<key>/<key>.md` and
`<root>/<key>/<key>.extraction/`. Unknown paper artifacts live at any path inside
the same document directory.

**Rationale**: The directory supplies the single assistant context while existing
key-based names and public artifact records remain intact. Same-filesystem renames
preserve bytes and provenance. Keeping the completion marker name preserves the
existing extraction contract.

**Alternatives considered**: `paper.pdf` and `extraction.md` would rename every file
without improving discovery. A nested `extraction/` name without the key would also
work, but changes more contracts for no behavioral gain. Sidecar-only metadata was
rejected because provenance remains embedded in the PDF.

## Existing-store migration

**Decision**: Migrate recognized flat PDF, Markdown and extraction paths before any
store read or serve. Resume partial moves, never overwrite a destination and fail
startup on a collision.

**Rationale**: Real user data must reach the new layout without a second current
copy. Renames preserve file bytes and identity. Restricting sources to recognized
legacy names leaves filing, removed-key records and hidden staging untouched.

**Alternatives considered**: Dual-read compatibility was rejected because it leaves
two layouts indefinitely. A manual migration command would make ordinary provisioning
break the installed library. Copying was rejected because it duplicates current paper
records.

## Assistant location and migration

**Decision**: Create OpenCode sessions with `location.directory` set to the document
directory. When an existing chat has another location, call OpenCode's documented
`POST /api/session/{sessionID}/move` with that directory. Do not create or update an
`AGENTS.md` source catalog.

**Rationale**: The official API supports session creation at a location and movement
of an existing session. This preserves chat identity while enforcing the directory
boundary.

**Alternatives considered**: Replacing old chats would lose conversation history.
A symlink from a synthetic workspace would retain duplicate path authority and hide
artifacts. Recreating instructions after extraction would preserve the rejected
catalog model.

## Discovery and raw PDF access

**Decision**: Allow read-only directory listing, glob, grep and file reads beneath the
store root. Give only generic instructions to inspect the current directory and use
available enrichment. Keep `/api/ai/pdf-text/{key}?page=N` for exact raw pages and
`reader-view` for the reader's current page. Remove `/api/ai/text/{key}` and all
extraction-refresh behavior.

**Rationale**: The configured model rejects PDF input but can fetch bounded raw-page
text. Extraction and metadata files need no HTTP adapter: the model can discover and
read them itself. The permission rules cover current and future artifacts without
per-file changes. Shell, edits, subagents and arbitrary web access stay denied.

**Alternatives considered**: Keeping the extraction endpoint would retain duplicate
source handling. Enabling shell for `pdftotext` would violate the assistant security
boundary. Attaching PDFs directly is not supported by the configured model.

## Verification

**Decision**: Use real HTTP store regressions for layout and migration, the private
OpenCode server for location and permissions, and the real configured provider for
raw-page plus unknown-artifact discovery. Verify the provisioned app on port 8770.

**Rationale**: Path helper tests alone cannot prove capture, indexing, extraction or
user-visible assistant behavior. A generated-instruction assertion cannot prove that
the model can discover resources.

**Alternatives considered**: Mock model answers were rejected as evidence of source
use. Endpoint-only tests were rejected because they preserve the old architecture.
