# Feature Specification: Deliberate Zotero Transfer

**Feature Branch**: `006-zotero-transfer`
**Created**: 2026-11-22
**Status**: Draft
**Input**: Existing explicit citation-store transfer behavior

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Send a paper deliberately (Priority: P1)

The user can choose to send a paper to Zotero, with or without extraction output,
without capture or reading causing an implicit citation write.

**Independent Test**: Capture, read, extract, and organize a paper without sending it,
then send it explicitly and inspect the citation record.

**Acceptance Scenarios**:
1. **Given** a captured paper, **When** the user does not choose send, **Then** no
   citation-store record is created.
2. **Given** a selected citation collection, **When** the user sends the paper,
   **Then** the citation and requested attachment are created.
3. **Given** an extraction result, **When** the user chooses send-and-extract,
   **Then** the requested extraction output accompanies the transfer.
4. **Given** a paper, **When** the user chooses Send PDF Only, **Then** a standalone
   PDF attachment is transferred without an extraction requirement.

### User Story 2 - Handle transfer failure (Priority: P1)

The user can see why a transfer failed and continue using the local paper.

**Independent Test**: Disable the citation-store service and attempt a transfer.

**Acceptance Scenarios**:
1. **Given** the citation store is unavailable, **When** the user sends a paper,
   **Then** the failure is visible and the local record remains intact.
2. **Given** a partial transfer failure, **When** the user retries deliberately,
   **Then** the application reports the new result without duplicating success claims.

### User Story 3 - Use the user's connector (Priority: P2)

The user can open a reader page with citation metadata and deliberately invoke their
own connector action.

**Independent Test**: Open a reader page in a browser and invoke the connector.

**Acceptance Scenarios**:
1. **Given** a reader page, **When** the user invokes the connector, **Then** the
   page exposes the paper's citation metadata.
2. **Given** no connector action, **When** the user reads or organizes a paper,
   **Then** no citation-store write occurs.

### Edge Cases
- A selected collection may be unavailable.
- The citation store may reject a duplicate or incomplete record.
- Attachment transfer may fail after citation creation.
- A user may choose the reader URL and their browser connector instead of the
  in-app send action.

## Requirements *(mandatory)*
### Functional Requirements
- **FR-001**: Citation-store writes MUST require an explicit user action.
- **FR-002**: Capture, extraction, reading, and library operations MUST NOT write to
  the citation store implicitly.
- **FR-003**: The send action MUST support a paper-only transfer and a transfer that
  includes requested extraction output.
- **FR-004**: The send action MUST support Send PDF Only without requiring an
  extraction.
- **FR-005**: The user MUST be able to target the citation store's selected
  collection when collection selection is available.
- **FR-006**: Transfer failures MUST be visible and MUST preserve the local paper.
- **FR-007**: Reader pages MUST expose citation metadata for an explicit connector
  action.

### Key Entities
- **Citation Transfer**: Explicit request and result.
- **Citation Record**: External bibliographic record.
- **Attachment**: Paper or extraction sent with the record.

## Success Criteria *(mandatory)*
### Measurable Outcomes
- **SC-001**: 0% of capture, extraction, reading, and organization tests create
  implicit citation-store writes.
- **SC-002**: 95% of successful send tests create the expected citation and attachment.
- **SC-003**: 100% of failed transfer tests preserve the local paper and show the
  failure.
- **SC-004**: Users complete an explicit send in under 30 seconds in 90% of tests.
- **SC-005**: 100% of Send PDF Only tests create a standalone PDF attachment without
  requiring extraction.

## Assumptions
- Zotero remains the citation system of record.
- Local Math PDF Reader state remains available regardless of external transfer state.
- Connector actions are initiated by the user.
