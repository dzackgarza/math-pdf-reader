# Research: Structured Extraction and Source Discovery

## Decision: Keep extraction providers as external manifest commands

**Rationale**: The repository already models providers as commands with JSON manifests.
Keeping that boundary prevents provider SDKs and credentials from entering the desktop app
and lets eligibility be checked before a job starts.

**Alternatives considered**: Importing MinerU/Mistral SDKs was rejected by the constitution
and would couple the app to provider credentials and release cycles.

## Decision: Treat arXiv LaTeX as a source-backed promotion target

**Rationale**: A confident arXiv match provides a stronger extraction path than a generic
PDF text layer. Promotion must be an explicit state transition, not merely an external
link: the arXiv item becomes the preferred working representation and its LaTeX source
can become authoritative.

**Alternatives considered**: Adding the arXiv PDF as an ordinary mirror was rejected because
ordinary recovery requires the original SHA-256 and would reject changed arXiv bytes.
Overwriting the current PDF was rejected because it would corrupt immutable provenance.

## Decision: Preserve the original as a linked alternate record

**Rationale**: Capture provenance is immutable and the original bytes must remain recoverable.
Promotion therefore creates or reuses a distinct arXiv-backed item and records the lineage
between the original and promoted representations. The UI can select the promoted item while
the original remains present.

**Alternatives considered**: Deleting the original or mutating its provenance would violate
the provenance invariant. A UI-only selection without durable linkage would make the
relationship impossible to recover after restart.

## Decision: Require server-side validation of promotion candidates

**Rationale**: The browser is not trusted to preserve the search response. The server must
recheck the confidence threshold, arXiv host/path, candidate identifier, and fetched PDF
before creating the promoted representation.

**Alternatives considered**: Trusting the posted candidate or accepting arbitrary URLs would
turn the promotion endpoint into an unrestricted import path and bypass source eligibility.

## Decision: Test the user-visible API boundary with real fixtures

**Rationale**: Source promotion changes storage, provenance, filing, and extraction
eligibility together. Tests must inspect the library payload and embedded provenance after
the transition, not only helper return values or HTTP status codes.

**Alternatives considered**: Unit-only scoring tests and synthetic provider/desktop mocks do
not prove the required replacement workflow.
