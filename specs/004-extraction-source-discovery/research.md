# Research: Structured Extraction and Source Discovery

## Decision: Keep extraction providers as external manifest commands

**Rationale**: The repository already models providers as commands with JSON manifests.
Keeping that boundary prevents provider SDKs and credentials from entering the desktop app
and lets eligibility be checked before a job starts.

**Alternatives considered**: Importing MinerU/Mistral SDKs was rejected by the constitution
and would couple the app to provider credentials and release cycles.

## Decision: Treat arXiv LaTeX as a source-backed replacement target

**Rationale**: A confident arXiv match provides a stronger extraction path than a generic
PDF text layer. Promotion is an explicit replacement action: the arXiv PDF becomes
the paper's current document and its LaTeX source can become authoritative.

**Alternatives considered**: Adding the arXiv PDF as an ordinary mirror was rejected because
ordinary recovery requires the original SHA-256 and would reject changed arXiv bytes.
Replacing only the PDF bytes was rejected because it would leave the old extraction
paired with a new source and lose the captured provenance.

## Decision: Replace the captured paper under its stable key

**Rationale**: The user chose to replace the captured paper. An atomic directory
exchange installs the arXiv PDF under the same key, keeps filing and reading state,
and removes the old PDF and extraction from the active store. The new PDF embeds
its arXiv provenance and the captured provenance as historical lineage.

**Alternatives considered**: A second active item would keep the superseded capture
in the library. Replacing only the PDF would strand an extraction from the old source.
The old PDF remains intact when validation, fetch, or publication fails.

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
