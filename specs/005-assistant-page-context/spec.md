# Feature Specification: Assistant Paper Sources and Page Context

**Feature Branch**: `005-assistant-page-context`
**Created**: 2026-11-22
**Status**: Draft
**Input**: Existing assistant behavior and the raw-PDF and page-context contract

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Start a session for a stored paper (Priority: P1)

The user can ask questions about every stored paper. The assistant reads page-addressed
text from the original PDF and uses a valid structured extraction as additional context
when one exists.

**Independent Test**: Ask for a sentence from a known page with valid, missing, and
invalid extractions.

**Acceptance Scenarios**:
1. **Given** a valid structured extraction, **When** a session starts, **Then** the
   assistant is directed to both the original PDF and the extraction.
2. **Given** no valid extraction, **When** the user asks about a PDF page, **Then** the
   assistant answers from that page of the original PDF.
3. **Given** a garbled PDF text snippet, **When** a session starts, **Then** the
   snippet is not used as a replacement for reading the paper.

### User Story 2 - Ask about the current page (Priority: P1)

The user can ask about the page currently displayed in the reader. The assistant can
fetch that page's text from the original PDF and locate the relevant passage in an
available structured extraction using its own tools.

**Independent Test**: Display a known page and inspect the context sent for a
page-specific request.

**Acceptance Scenarios**:
1. **Given** the reader displays page 16, **When** the user asks a question, **Then**
   context states page 16 exactly.
2. **Given** an authoritative extraction file exists, **When** context is built,
   **Then** it provides a pointer to that file and directs the assistant to search and
   read it using its own tools.
3. **Given** a small PDF text snippet, **When** context is built, **Then** the
   snippet is labeled only as a search hint and is not the paper text.
4. **Given** a page-specific request, **When** context is built, **Then** the
   application does not attempt approximate page-to-extraction mapping.

### User Story 3 - Receive explicit failures (Priority: P1)

The user can distinguish unavailable paper context from assistant execution failure.
The assistant pane reports an execution failure without attributing it to a missing
extraction.

**Independent Test**: Trigger each failure boundary and verify the user-visible state.

**Acceptance Scenarios**:
1. **Given** missing extraction, **When** a session starts, **Then** the session
   succeeds with the original PDF as its paper source.
2. **Given** the structured-text endpoint is queried for a missing extraction,
   **When** the response arrives, **Then** it identifies the absent extraction.
3. **Given** unavailable paper context or an assistant execution failure, **When**
   the request is made, **Then** no success-shaped answer is returned.

### Edge Cases
- A page snippet may contain garbled formulas or figure text.
- The reader page number may be valid while the extraction has no exact page mapping.
- An extraction may not contain page markers; the assistant must use the exact page
  number and the hint to locate the passage itself.
- Generic full-document `pdftotext` or PyMuPDF output is not a structured extraction.

## Requirements *(mandatory)*
### Functional Requirements
- **FR-001**: Every stored PDF MUST support assistant sessions regardless of
  extraction state.
- **FR-002**: Assistant context MUST identify the original stored PDF and its
  page-text address. The assistant MUST be able to read a selected page without a
  structured extraction.
- **FR-003**: Page context MUST include the exact page number supplied by the reader.
- **FR-004**: When an authoritative extraction exists, page context MUST identify it
  and direct the assistant to search and read it with its own tools.
- **FR-005**: Page context MAY include only a small naively extracted PDF snippet as
  a clearly labeled search hint.
- **FR-006**: The hint MUST NOT be presented as source text or used in place of
  reading the paper.
- **FR-007**: The application MUST NOT map pages to extraction locations by matching
  PDF text.
- **FR-008**: Extraction absence MUST leave assistant availability unchanged.
- **FR-009**: Assistant context endpoints MUST NOT return full-document PDF text as
  the paper source.
- **FR-010**: Full-document output from `pdftotext`, PyMuPDF, or equivalent PDF text
  libraries MUST NOT be treated as an authoritative structured extraction.
- **FR-011**: The assistant MUST be given the exact reader page number even when no
  authoritative extraction exists.
- **FR-012**: The assistant's read permissions MUST include the stored raw PDF.

### Key Entities
- **Assistant Session**: User question, original PDF, optional extraction, and
  context state.
- **Page Context**: Exact page, optional extraction location, and bounded hint.
- **Authoritative Extraction**: Structured paper text that supplements the original
  PDF when a valid extraction exists.

## Success Criteria *(mandatory)*
### Measurable Outcomes
- **SC-001**: 100% of valid-session tests identify the original PDF and any available
  authoritative extraction.
- **SC-002**: 100% of page-context tests include the exact reader page number.
- **SC-003**: 100% of missing-extraction session tests succeed, identify the raw PDF,
  and answer a question from a selected raw-PDF page.
- **SC-004**: 0% of tests use naively extracted PDF text as authoritative structured
  content.
- **SC-005**: 100% of assistant execution failures produce a distinct explicit error.
- **SC-006**: 100% of page-context tests provide the extraction pointer when an
  authoritative extraction exists.

## Assumptions
- The reader already knows the exact displayed page number.
- The configured model may reject PDF file attachments. The bucket supplies text from
  one raw-PDF page per request so the model can read the paper as text.
- The assistant can search or navigate an available authoritative extraction itself.
- A page hint is optional and subordinate to the original PDF and any extraction.
