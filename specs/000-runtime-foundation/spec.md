# Feature Specification: Math PDF Reader Runtime Foundation

**Feature Branch**: `000-runtime-foundation`
**Created**: 2026-11-22
**Status**: Draft
**Input**: M0 walking-skeleton behavior recovered from the project roadmap and transcript

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Open the reader workspace (Priority: P1)

When the user launches Math PDF Reader, the application opens a usable desktop
window with its local server and reader workspace available.

**Independent Test**: Launch the installed application, open one known PDF, and
reload its stable local reader address.

**Acceptance Scenarios**:
1. **Given** a valid installed build, **When** the user launches the application,
   **Then** the desktop window opens and the local application server is reachable.
2. **Given** one stored PDF, **When** the user opens it, **Then** it is rendered in
   the reader workspace and has a stable local HTTP address.
3. **Given** a reader address, **When** the user reloads or revisits it while the
   application is running, **Then** the same paper remains addressable.

### User Story 2 - Surface startup failure (Priority: P1)

When the application cannot build or start, the user sees the failure instead of
being given a stale or silently degraded application.

**Independent Test**: Exercise a failed build and an unavailable local server and
verify that each produces an actionable visible failure.

**Acceptance Scenarios**:
1. **Given** an application build failure, **When** the user launches the app,
   **Then** startup is blocked and the failure is visible.
2. **Given** the local server is unavailable, **When** the desktop window attempts
   to open, **Then** the user sees an actionable error rather than a blank reader.

## Requirements *(mandatory)*

### Functional Requirements
- **FR-001**: The application MUST provide a desktop window containing the library
  and reader workspace.
- **FR-002**: The application MUST serve every stored PDF and reader page through a
  stable local HTTP address while it is running.
- **FR-003**: The initial runtime MUST support opening at least one stored PDF in the
  reader and revisiting its stable address.
- **FR-004**: A failed build or unavailable server MUST be visible and MUST prevent
  stale or blank startup.
- **FR-005**: The application MUST preserve the distinction between the local reader
  address and the original paper URL.

### Key Entities
- **Reader Address**: Stable local HTTP address for a paper or reader page.
- **Application Runtime**: Desktop window, local server, and reader workspace.

## Success Criteria *(mandatory)*

### Measurable Outcomes
- **SC-001**: 100% of smoke tests launch the desktop window and reach the local
  server or show an actionable failure.
- **SC-002**: 100% of one-paper smoke tests open the PDF through a stable local
  reader address.
- **SC-003**: 100% of intentional build and server failures remain visible and do
  not open stale or blank application state.

## Assumptions
- The application runs as a local desktop application with a local HTTP server.
- The initial walking skeleton needs one stored PDF, not the complete library.
