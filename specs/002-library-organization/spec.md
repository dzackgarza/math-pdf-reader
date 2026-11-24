# Feature Specification: Library Organization

**Feature Branch**: `002-library-organization`
**Created**: 2026-11-22
**Status**: Draft
**Input**: Existing Math PDF Reader library, collection, tag, and saved-search behavior

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Browse and filter papers (Priority: P1)

The user can browse captured papers and quickly narrow the library to unfiled,
unread, recently added, offline, or needs-recovery papers. The unfiled view is
presented as Inbox.

**Independent Test**: For each quick filter, seed both matching and nonmatching
papers. Compare the displayed paper IDs with the full set expected from the seed.

**Acceptance Scenarios**:
1. **Given** papers with different states, **When** a quick filter is selected,
   **Then** the library shows every matching paper and excludes every nonmatching paper.
2. **Given** no papers match, **When** a filter is selected, **Then** the empty state
   explains the result without showing unrelated papers.
3. **Given** a paper is in no collection, **When** the user opens Inbox, **Then** the
   paper is included.

### User Story 2 - File and tag papers (Priority: P1)

The user can place papers in nested collections and apply tags that support later
retrieval. Collections may also define rules, descriptions, pinning, offline
retention, and activity history.

**Independent Test**: Create nested collections, file papers, tag them, and retrieve
them through each path.

**Acceptance Scenarios**:
1. **Given** a paper and collection, **When** the user files it, **Then** it appears
   in that collection and remains in the overall library.
2. **Given** a paper with multiple tags, **When** a tag is selected, **Then** all
   matching papers are shown.
3. **Given** a saved collection rule, **When** paper metadata changes, **Then** the
   collection membership updates according to that rule.

### User Story 3 - Inspect paper details (Priority: P2)

The user can inspect provenance, cache state, source locations, and reading state
without opening another application.

**Independent Test**: Open the inspector for papers with complete and incomplete
metadata and verify the displayed states.

**Acceptance Scenarios**:
1. **Given** a stored paper, **When** its inspector opens, **Then** source, file,
   cache, hash, and mirror information is visible.
2. **Given** missing metadata, **When** the inspector opens, **Then** the missing
   state is explicit rather than replaced with a guessed value.

### Edge Cases
- A paper may belong to multiple collections and have no collection.
- Tags may be removed while saved searches still reference them.
- An empty result must be distinguishable from a failed library load.
- Keep Offline is a retention preference, not a second library view.

## Requirements *(mandatory)*
### Functional Requirements
- **FR-001**: The library MUST display captured papers with stable identity and
  reading state.
- **FR-002**: The library MUST provide unfiled, unread, recent, offline, and
  needs-recovery filters, with unfiled papers represented by Inbox.
- **FR-003**: Users MUST be able to create nested collections and file papers in them.
- **FR-004**: Users MUST be able to add, remove, and filter by tags.
- **FR-005**: Users MUST be able to define and use saved searches.
- **FR-006**: Collections MUST support rules, descriptions, pinning, offline
  retention, and activity history.
- **FR-007**: The inspector MUST show provenance, cache state, file identity, and
  known source locations.
- **FR-008**: Missing or failed metadata MUST be shown explicitly.

### Key Entities
- **Paper**: Captured document and its library state.
- **Collection**: Nested filing location.
- **Tag**: User-applied retrieval label.
- **Saved Search**: Reusable library query.

## Success Criteria *(mandatory)*
### Measurable Outcomes
- **SC-001**: Users retrieve a seeded paper using a collection or tag on the first
  attempt at least 90% of the time.
- **SC-002**: For every quick filter, the displayed paper IDs equal the expected set,
  including when that set is empty.
- **SC-003**: Users can file a paper and verify its new location in under 20 seconds.
- **SC-004**: No missing metadata is rendered as a success-shaped placeholder.
- **SC-005**: 100% of collection-rule fixtures update membership after the relevant
  paper metadata changes.

## Assumptions
- The library is local to one user.
- Collection and tag changes are immediately reflected in the current library view.
- Saved searches are user-owned and may combine existing library fields.
