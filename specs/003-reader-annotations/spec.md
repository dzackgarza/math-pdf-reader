# Feature Specification: Reader Navigation and Annotations

**Feature Branch**: `003-reader-annotations`
**Created**: 2026-11-22
**Status**: Draft
**Input**: Existing Math PDF Reader reading, navigation, highlight, and note behavior

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Read a stored paper (Priority: P1)

The user can open any stored paper at a stable local reader address and continue
reading from the selected paper. The reader fills the reading area; provenance and
mirror information remain in the library inspector.

**Independent Test**: Open papers from the library and verify stable reader access.

**Acceptance Scenarios**:
1. **Given** a stored paper, **When** it is opened, **Then** its reader address is
   stable for the running application.
2. **Given** a paper that cannot be opened, **When** the user selects it, **Then**
   the failure is visible and the library record remains available.
3. **Given** a reader page is reloaded with a page fragment, **When** it opens,
   **Then** the same page is displayed.

### User Story 2 - Navigate and search (Priority: P1)

The user can navigate by page, outline, or document search and reach the relevant
location without relying on approximate text matching.

**Independent Test**: Use page navigation, outline entries, and known search terms.

**Acceptance Scenarios**:
1. **Given** a target page, **When** the user selects it, **Then** the reader
   displays that exact page.
2. **Given** an outline entry or search result, **When** it is selected, **Then**
   the reader moves to its document location.

### User Story 3 - Save highlights and notes (Priority: P2)

The user can annotate a paper and find those annotations after closing and reopening
the reader.

**Independent Test**: Create, reopen, edit, and remove annotations across a restart.

**Acceptance Scenarios**:
1. **Given** selected paper text, **When** the user highlights it, **Then** the
   highlight is associated with the paper.
2. **Given** a saved note, **When** the paper is reopened, **Then** the note remains
   visible at its document location.

### Edge Cases
- A document may have no outline or searchable text.
- A page may be outside the document's valid page range.
- Annotation persistence may fail and must be reported without claiming success.

## Requirements *(mandatory)*
### Functional Requirements
- **FR-001**: Every stored paper MUST have a stable reader address while the
  application is running.
- **FR-002**: Reader navigation MUST preserve the displayed page in the reader URL.
- **FR-003**: The reader MUST support exact page navigation.
- **FR-004**: The reader MUST support outline navigation and document search when
  those document features exist.
- **FR-005**: Users MUST be able to create, edit, and remove highlights and notes.
- **FR-006**: Annotations MUST remain associated with the paper after reopening.
- **FR-007**: Invalid navigation and annotation persistence failures MUST be visible.
- **FR-008**: Reader pages MUST expose Highwire citation metadata needed for an
  explicit connector action.
- **FR-009**: Provenance and mirror details MUST remain in the library inspector and
  MUST NOT replace the full-width reader.

### Key Entities
- **Reader Session**: Current paper, page, search, and navigation state.
- **Annotation**: Highlight or note tied to a paper location.

## Success Criteria *(mandatory)*
### Measurable Outcomes
- **SC-001**: Users reach a known page in under 5 seconds in 95% of acceptance tests.
- **SC-002**: 100% of saved annotations survive closing and reopening the paper.
- **SC-003**: 90% of users complete a highlight-and-note task without assistance.
- **SC-004**: Invalid page and persistence failures are reported in 100% of tests.
- **SC-005**: 100% of reload tests restore the page named by the reader URL.

## Assumptions
- The reader is used locally by one user.
- Annotation export remains part of the stored paper workflow.
- Citation metadata is exposed for deliberate connector use, not automatic writes.
