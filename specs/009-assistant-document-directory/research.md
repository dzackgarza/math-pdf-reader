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

## Directory tools

The session location supplies the paper context. The assistant can inspect new
artifacts using file tools and shell commands without a new endpoint or instruction.
Keeping the original beside the extraction lets it check a source when conversion
has lost information. The [page-context spec](../005-assistant-page-context/spec.md)
defines the displayed page and optional search hint.
