# Feature Specification: Assistant Document Directory

**Feature Branch**: `009-assistant-document-directory`
**Created**: 2026-11-24
**Status**: Draft
**Input**: Point the assistant at the single directory that stores a paper. Keep the PDF, extractions, metadata and other paper-specific artifacts together. Let the assistant discover what is present and decide what to use.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Ask with every available paper source (Priority: P1)

The user opens a paper's assistant and asks a question. The assistant works in the
paper's own document directory, discovers the original and any enrichment that exists,
and chooses the sources that answer the question. A missing extraction never makes the
assistant unavailable.

**Why this priority**: The assistant must use the whole paper record without a separate
source-registration step or an extraction prerequisite.

**Independent Test**: Open the assistant for a paper with only its original document,
then repeat for a paper with an extraction and additional paper-specific metadata. In
both cases, ask a question that requires reading the paper and inspect which available
sources the assistant used.

**Acceptance Scenarios**:
1. **Given** a paper with no extraction, **When** its assistant opens, **Then** the
   assistant answers from the original document in that directory when its tools can
   read the requested content. If the content is illegible, it reports the limitation.
2. **Given** a paper with an extraction and paper-specific metadata, **When** its
   assistant opens, **Then** the assistant can discover and read those resources without
   being given a separate catalog of their locations. It can use its shell to search
   a Markdown extraction and read the matching passage.
3. **Given** several papers, **When** an assistant session opens, **Then** its document
   directory belongs to the selected paper alone.

---

### User Story 2 - Enrich an already-open paper (Priority: P1)

The user adds an extraction or another paper-specific artifact while the paper's
assistant is open. On the next question, the assistant can discover the new artifact in
the same directory without restarting the chat or receiving a rebuilt source catalog.

**Why this priority**: Enrichment is an ordinary change to the paper record, not a new
assistant session or a synchronization workflow.

**Independent Test**: Open a chat for a paper without an extraction, place a valid
extraction in that paper's directory, and ask a question whose answer requires the new
content in the same chat.

**Acceptance Scenarios**:
1. **Given** an open chat and a newly completed extraction, **When** the user asks
   another question, **Then** the assistant can discover and read the extraction in the
   existing document directory.
2. **Given** a failed or incomplete enrichment, **When** the user asks another question,
   **Then** the original document remains available and no incomplete artifact is
   presented as complete.

### Edge Cases

- A paper has no enrichment beyond its original document.
- An enrichment arrives after the assistant session was created.
- An enrichment command fails or is still running.
- A paper-specific artifact has a type the application did not previously know.
- Two papers have similar titles or source addresses but different document identities.
- A document directory is missing its original document or that document is invalid.
  Opening its chat reports which condition prevents reading.
- If hint extraction fails for a valid PDF, the exact reader page and the session
  remain available. The page context identifies the hint failure separately.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Each stored paper MUST have one document directory that contains its
  original document and all paper-specific enrichment artifacts.
- **FR-002**: Opening a paper's assistant MUST make that paper's document directory its
  working context. The assistant MUST NOT require a generated source catalog or a
  separate synthetic workspace.
- **FR-003**: The assistant MUST be able to enumerate and read the current contents of
  its document directory and choose among the available resources itself.
- **FR-004**: Adding a complete paper-specific artifact MUST make it discoverable to an
  existing assistant session on a later turn without restarting the session or sending
  a source-refresh notification.
- **FR-005**: The original document MUST remain usable by the assistant when no
  extraction exists or an extraction fails.
- **FR-006**: Complete valid extractions and paper-specific metadata MUST remain
  available as additional context whenever they exist.
- **FR-007**: Paper-specific additions MUST NOT require changes to session instructions,
  per-file assistant permissions or an artifact registry before the assistant can read
  them.
- **FR-008**: Incomplete enrichment output MUST remain distinguishable from the
  complete paper record and MUST NOT replace the last complete extraction.
- **FR-009**: The document-directory organization MUST hold throughout capture, import,
  reading, annotation saves, extraction, deletion, export and recovery.
- **FR-010**: Reorganizing a paper's storage MUST preserve its identity, original
  document bytes, embedded provenance, extraction artifacts and stable item addresses.
- **FR-011**: The application MUST maintain one authoritative location for each
  paper-specific artifact, without duplicate current copies in separate workspaces.
- **FR-012**: Missing or invalid original documents MUST continue to fail explicitly.

### Key Entities

- **Document Directory**: The complete paper-specific workspace for one stored item.
- **Original Document**: The stored PDF with its embedded provenance; it is always the
  baseline source and is not an extraction.
- **Paper Artifact**: An extraction, source archive, metadata record or future resource
  that belongs to exactly one paper and lives in that paper's document directory.
- **Assistant Session**: A persistent conversation whose working context is one paper's
  document directory and which observes the directory's current contents.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For 100% of stored papers exercised in acceptance tests, the original
  document and every complete paper-specific artifact are in the same document
  directory and no current paper artifact resides only in a synthetic workspace.
- **SC-002**: The assistant answers from the original document without an extraction in
  every extraction-free acceptance case where its tools can read the PDF. When they
  cannot, the assistant reports the reading limitation.
- **SC-003**: The assistant discovers each available extraction and paper-specific
  metadata resource in 100% of enrichment acceptance cases without a source-specific
  prompt entry for that artifact.
- **SC-004**: An extraction added during an open conversation is usable in that same
  conversation in 100% of acceptance cases, with zero restarts or refresh notifications.
- **SC-005**: Capture and URL import return the key of the directory containing the
  PDF with its embedded provenance. The key resolves to that PDF and its reader.
  Reading, annotation saves and extraction keep the key and embedded provenance.
  Export retains the identity and provenance needed for recovery. Rebuild restores
  the PDF to the same key. After deletion the paper and its artifacts leave the
  active store together and its entry disappears from the next export.

## Assumptions

- Store-wide collections, saved searches and application settings are not
  paper-specific artifacts and remain outside an individual document directory.
- Provenance embedded in the original document remains authoritative; duplicating it
  into another metadata file is unnecessary.
- Existing stored papers retain their contents and identities when their storage is
  reorganized.
- The assistant chooses the tools it uses in the paper directory, including shell
  commands. The reader supplies the displayed page number and may supply a short
  text-layer search hint. The assistant checks the passage in the paper itself.
