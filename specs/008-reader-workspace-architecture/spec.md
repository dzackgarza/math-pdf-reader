# Feature Specification: Reader Workspace Architecture

**Feature Branch**: `008-reader-workspace-architecture`
**Created**: 2026-11-22
**Status**: Draft
**Input**: Original Claude project specification for shared reader ownership and tab state

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Work with multiple open papers (Priority: P1)

The user can open multiple papers in one window, switch between them, and return to
each paper without losing its reader state.

**Independent Test**: Open two papers, navigate each to a different page and zoom,
switch repeatedly, and verify both states.

**Acceptance Scenarios**:
1. **Given** two open papers, **When** the user switches papers, **Then** the selected
   paper becomes active without resetting the other paper.
2. **Given** an inactive paper, **When** the user returns to it, **Then** its page and
   zoom are restored.
3. **Given** a paper tab put to sleep, **When** it is reopened, **Then** it reloads at
   its recorded page and zoom.

### User Story 2 - Keep one coherent reader (Priority: P1)

The user experiences one coherent reader per window rather than separate competing
document lifecycles owned by individual tabs or views.

**Independent Test**: Open, activate, close, navigate, and serialize papers while
switching between library and reader views.

**Acceptance Scenarios**:
1. **Given** a paper is opened, **When** the user changes views, **Then** the same
   reader state remains authoritative.
2. **Given** a paper is activated from the library or a tab, **When** activation
   completes, **Then** both surfaces show the same active document and page.
3. **Given** a paper is closed, **When** it is removed from the workspace, **Then**
   its reading record is preserved separately from the active reader state.

### User Story 3 - Persist reader state safely (Priority: P1)

The user can navigate and annotate without losing document state or silently
overwriting newer saved PDF bytes.

**Independent Test**: Make navigation and annotation changes, save them, reload the
paper, and exercise a concurrent-save conflict.

**Acceptance Scenarios**:
1. **Given** a changed annotation, **When** the user saves, **Then** the stored PDF
   contains the annotation and the save result is visible.
2. **Given** a concurrent modification, **When** the user saves, **Then** the
   application detects the conflict rather than silently discarding either version.
3. **Given** a reader reload, **When** the paper opens, **Then** the saved document
   and reading state are restored.

### Edge Cases
- A library view may be visible while a reader remains loaded.
- A sleeping paper may have no live renderer until activated.
- Closing a reader must not delete the paper or its reading record.
- A stale save must not overwrite newer bytes.

## Requirements *(mandatory)*
### Functional Requirements
- **FR-001**: The application MUST maintain one authoritative reader/document manager
  per window.
- **FR-002**: The manager MUST own opening, activation, closing, navigation, and
  reader-state serialization.
- **FR-003**: Tabs and library views MUST display manager state rather than maintain
  competing document lifecycles.
- **FR-004**: The library tab MUST remain available while reader tabs are open.
- **FR-005**: The workspace MUST preserve page and zoom for inactive or sleeping
  papers.
- **FR-006**: Reader navigation MUST update the stable reader URL, including its
  displayed page.
- **FR-007**: Annotation saves MUST preserve the complete accepted PDF bytes and
  report save conflicts explicitly.
- **FR-008**: Reading records MUST remain distinct from the currently loaded reader
  instance.
- **FR-009**: Reader state MUST be restored after reload or reactivation.

### Key Entities
- **Reader Manager**: Authoritative per-window document and reader-state owner.
- **Workspace Tab**: View of a manager-owned library or paper state.
- **Reading Record**: Persistent page, zoom, and reading metadata.
- **PDF Revision**: Stored document bytes with save identity.

## Success Criteria *(mandatory)*
### Measurable Outcomes
- **SC-001**: 100% of multi-paper tests restore each paper's page and zoom.
- **SC-002**: 0% of activation tests show conflicting active-document state between
  library and tabs.
- **SC-003**: 100% of successful annotation saves persist the accepted PDF bytes.
- **SC-004**: 100% of concurrent-save conflicts are reported without silent overwrite.
- **SC-005**: Users can switch between two open papers in under 2 seconds in 95% of
  acceptance tests.

## Assumptions
- EmbedPDF remains the reader substrate and owns supported document rendering.
- The application stores reading records separately from the PDF renderer instance.
- A reader tab may sleep to conserve resources, provided its state is restorable.
