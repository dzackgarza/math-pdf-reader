# Type-System Pre-Pass: Assistant Document Directory

## 0. Traceability and scope

- Slice: `009-assistant-document-directory`, implementation-adjacent child of
  `PLAN-PDF-BUCKET-ROADMAP` under `FEATURE-PDF-BUCKET`.
- Source: the user requires one paper directory containing the PDF and every
  paper-specific artifact, with the assistant discovering its contents.
- Repository boundary: the Rust store and assistant server, their HTTP tests and
  the real configured OpenCode provider.
- Bounded contexts: document storage, library indexing, extraction placement and
  assistant sessions. Store-wide filing is outside this slice.

## 1. Domain vocabulary

| Term | Meaning | Context | Adjacent term not to confuse |
| --- | --- | --- | --- |
| `Key` | Validated identity of one stored paper | All four contexts | A file name or title alone |
| Document directory | `<root>/<key>/`, the only current paper record | Storage and assistant | Synthetic OpenCode workspace |
| Current PDF | `<root>/<key>/<key>.pdf`, with embedded provenance | Storage and assistant | Raw-page text or an extraction |
| Markdown extraction | `<root>/<key>/<key>.md`; its existence marks completion | Index and extraction | Raw PDF text |
| Extraction artifacts | `<root>/<key>/<key>.extraction/` | Index and extraction | Staging output |
| Paper artifact | Any current file in the document directory | Assistant and migration | Store-wide filing documents |
| Assistant session | Persistent OpenCode chat located in one document directory | Assistant | OpenCode server data under the AI root |
| Incomplete enrichment | Staging outside the document directory | Extraction | Complete extraction |

`Workspace` remains a UI term for library tabs. It MUST NOT denote an assistant
source directory.

## 2. Behavior research

Before this feature, the code stored `<root>/<key>.pdf` and adjacent extraction names,
indexed PDFs directly under the root, and created a hashed OpenCode workspace containing
a generated `AGENTS.md` source catalog. Extraction success rewrote that catalog and
`reader-view`. OpenCode's documented session API accepts `location.directory` and
provides `POST /api/session/{id}/move`, which preserves an existing chat while moving it
to the paper directory.

### Invariants and current violations

- One directory holds each paper's complete current record. The flat layout violates it.
- The current PDF exists independently of every extraction. Opening the session must preserve access to this file.
- Only a completed extraction is visible as complete. Root staging satisfies this;
  the new placement MUST retain it.
- A session reads current paper artifacts without instruction regeneration. The
  synthetic workspace violates this.
- An item key retains its HTTP identity through reorganization. URL paths already
  use keys and MUST NOT change.
- Migration MUST NOT overwrite a current artifact. Current code has no migration.

### Transitions

| State | Required fields | Legal next states | Forbidden states |
| --- | --- | --- | --- |
| Capturing | Staged PDF, original hash, provenance | Stored | PDF in the store before provenance succeeds |
| Stored without extraction | Key, current PDF | Extracting, replaced, removed | Extraction prerequisite for assistant |
| Extracting | Stored PDF, hidden staging directory | Stored with extraction, unchanged stored state | Staging inside the paper directory; partial success |
| Stored with extraction | Current PDF, Markdown completion marker, optional artifacts | Extracting, replaced, removed | New artifacts replacing the previous complete set before success |
| Assistant open | Existing document directory, session ID | Same session after enrichment or page changes | Source catalog refresh or synthetic current copies |
| Legacy flat record | One or more recognized legacy paths | Document directory | Overwriting a destination; duplicated current record |

Valid examples include a PDF-only paper, LaTeX source with its single Markdown reading copy,
and an unknown `notes.txt` added directly to the paper directory. Invalid examples
include a key with a separator, extraction output placed before validation, two
current PDFs for one key, and migration over an existing destination. An orphan
legacy Markdown or extraction directory still migrates under its key; it does not
manufacture a current PDF or hide its absence.

## 3. Core typed model

### Bounded primitives and products

- `layout::Key(String)` remains the only validated paper identity.
- `DocumentDirectory { key: Key, path: PathBuf }` is the conceptual product. It is
  represented by `layout::document_dir(root, &Key)` rather than a second wrapper
  because no behavior requires a separate public type.
- `StoredFile` continues to pair `Key`, path, byte size and signature for indexing.
- `Extraction` remains the existing `None | Extracted` sum type; raw PDF text never
  enters it.
- `AppError` and `std::io::Error` carry route and migration failures respectively.

### Workflow signatures

- `document_dir(root, &Key) -> PathBuf` (pure).
- `pdf_path(root, &Key)`, `markdown_path(root, &Key)` and
  `extraction_dir(root, &Key)` derive only paths inside that directory (pure).
- `migrate(root) -> io::Result<()>` moves recognized legacy paths, resumes partial
  moves and refuses destination collisions (effectful).
- `capture -> storeplace` creates the document directory before committing the PDF.
- `place_extraction` atomically renames validated output into the same directory,
  completion marker last (effectful, existing per-key lock).
- `OpenCode create session {location.directory}` and
  `move existing session {directory}` preserve one chat in the document directory.

### Compile-time boundary checks

`cargo check --package pdf-bucket` checks all changed route, store and assistant
signatures. `bun run typecheck` checks the test and contract side. Intentional
failures include calling layout functions with unparsed strings or returning an
AI session before storage/migration errors are handled.

## 4. Functional core and effectful ports

Pure path derivation lives only in `layout.rs`. `index.rs` consumes those paths to
classify files. Filesystem rename, directory creation, trash and fsync remain store
or layout effects. OpenCode is the assistant-session port through its typed JSON
HTTP payloads. The extraction plugin contract remains an external-command port.
No new abstraction or duplicate path convention is introduced.

## 5. Boundary parser policy

HTTP keys pass `Key::parse` before path construction. Library scanning accepts only
a document directory whose name is a valid key and the matching `<key>.pdf`.
OpenCode responses use Serde structures for session existence and location. Plugin
output remains validated before placement. Unknown paper artifacts need no parser
for assistant discovery; the library exposes only the typed extraction contract.

## 6. Shared policies

- Ordering: migration and indexing proceed in key order where observable.
- Conflicts: migration refuses every source/destination collision; capture never
  chooses a nonempty document directory belonging to another candidate key.
- Idempotency: completed migration is a no-op; partial migration resumes only when
  each remaining destination is absent.
- Atomicity: PDF bytes move by same-filesystem rename; extraction completion remains
  Markdown-last; delete moves the whole paper directory to trash.
- Identity: keys, embedded provenance and `/pdf/<key>.pdf` plus `/read/<key>` do not
  change.
- Session movement: use OpenCode's standard move operation, not a replacement chat.
- Source discovery: directory read/glob/grep plus file read; no source-specific
  artifact registry, per-file prompt entries or refresh notification.

## 7. Interfaces and architecture seams

The public bucket session request and response are unchanged. The private OpenCode
session create body gains the real paper directory; existing sessions move when
their location differs. The displayed page and optional correlation hint are reader state. `/api/ai/text/{key}` disappears because direct
artifact reads replace it. The library, export and Zotero contracts retain their
item-relative artifact names.

## 8. Escape-hatch policy and debt ledger

No new `Any`, `any`, `unknown`, broad cast or unchecked JSON value enters the domain.
OpenCode request construction uses the existing `serde_json::json!` adapter only.
Responses are parsed into named Serde types. No type debt is accepted.

## 9. Sequencing

1. Characterize the flat layout and endpoint-driven assistant with failing HTTP
   regressions.
2. Commit the path model and one-way migration.
3. Move capture, replacement, extraction, indexing, deletion, export and Zotero reads
   onto the directory model.
4. Locate new and existing assistant sessions in that directory; enable generic
   discovery and remove catalog refresh and extraction-text endpoint behavior.
5. Update specifications and durable user documentation.
6. Run focused checks, provision, and verify raw-only, enriched and newly added
   unknown-artifact behavior on port 8770.
7. Remove legacy synthetic workspaces only after their sessions have moved or are no
   longer referenced; do not delete user chats or paper artifacts.

## 10. Minimal artifacts

This pre-pass contains the behavior matrix, transitions, invariants and zero-debt
ledger. `data-model.md` records the same public model. `quickstart.md` records the
real boundary checks.

## 11. Completion evidence and acceptance

- [x] Bounded contexts and terminology decided.
- [x] Valid, invalid and partial-migration cases documented.
- [x] Typed primitives, sums, transitions and errors identified.
- [x] Pure paths separated from filesystem and OpenCode effects.
- [x] Parser and conflict policies fixed.
- [x] No escape hatch introduced.
- [x] Compiler checks named for the typed boundaries.
- [x] Acceptance derives from the user's document-directory requirement, not from
  the existing implementation.

## 12. Linkages

- Follow-on plan: `specs/009-assistant-document-directory/plan.md`.
- Tasks MUST prove migration and real assistant discovery before completion.
