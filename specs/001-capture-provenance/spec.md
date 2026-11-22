# Feature Specification: PDF Capture and Provenance

**Feature Branch**: `001-capture-provenance`
**Created**: 2026-11-22
**Status**: Draft
**Input**: Existing Math PDF Reader capture behavior and provenance requirements

## Clarifications

### Session 2026-11-22

- Q: Which desktop-session behavior should the specification require when the reader window cannot be focused or raised? → A: Focus is best effort for supported sessions; unsupported sessions are out of scope, and a focus failure must not fail the capture.
- Q: Which desktop sessions should be explicitly supported for reader-window focus? → A: Wayland only.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Capture a browser PDF (Priority: P1)

When a user opens a PDF in Chrome or Firefox, Math PDF Reader captures it and
opens it locally instead of silently losing the navigation.

**Independent Test**: Navigate to PDF fixtures in Chrome and Firefox and verify
that each eligible response is captured or produces an actionable error.

**Acceptance Scenarios**:
1. **Given** an eligible PDF navigation, **When** it completes, **Then** the PDF is
   stored and opened in Math PDF Reader.
2. **Given** the reader is unavailable, **When** capture fails, **Then** the user sees
   the error and can open the PDF natively.
3. **Given** a non-eligible navigation, **When** it completes, **Then** it is not
   intercepted.

4. **Given** the capture integration is disabled in browser settings, **When** a PDF
   navigation completes, **Then** the browser leaves it native and the library shows
   the disabled capture status.
5. **Given** a PDF is captured under a Wayland desktop session, **When** the capture
   completes, **Then** the Math PDF Reader window receives focus and presents the
   captured paper when the desktop permits it; otherwise the runtime reports an
   actionable focus failure without treating the capture itself as failed.

### User Story 2 - Preserve provenance (Priority: P1)

The user can identify where and when every stored paper was captured and verify its
original file identity.

**Independent Test**: Capture a PDF, restart the application, and inspect its details.

**Acceptance Scenarios**:
1. **Given** a stored PDF, **When** its details are opened, **Then** source URL,
   capture time, and original SHA-256 are available.
2. **Given** a stored PDF is reindexed, **When** its record is rebuilt, **Then**
   provenance remains recoverable from the PDF itself.

### User Story 3 - Recover a source (Priority: P2)

The user can verify or recover a paper from its original URL or known mirrors without
losing the local copy.

**Independent Test**: Exercise successful, unavailable, and alternate-mirror recovery
fixtures.

**Acceptance Scenarios**:
1. **Given** an unavailable original URL and a working mirror, **When** recovery is
   requested, **Then** the mirror is offered and provenance is preserved.
2. **Given** all sources are unavailable, **When** recovery is requested, **Then** the
   failure is visible and the local PDF remains intact.

3. **Given** a paper is marked Needs Re-fetch, **When** the user chooses rebuild from
   metadata, **Then** the original PDF URL is tried once, followed by each known
   mirror in stored order.

### Edge Cases
- Every eligible GET navigation whose response is identified by content type,
  download filename, or `.pdf` path is intercepted.
- POST responses, embedded frames smaller than the configured
  `capture.min_frame_width` × `capture.min_frame_height` threshold (700×350 by
  default), and the reader's own origin are excluded.
- Chrome and Firefox must apply the same interception rules.
- The capture page must report that the bucket is unavailable rather than silently
  dropping the PDF.
- Reader-window focus behavior is specified for Wayland only; non-Wayland sessions
  are out of scope for focus validation.

## Requirements *(mandatory)*

### Functional Requirements
- **FR-001**: The application MUST intercept eligible PDF navigations in both supported
  browsers using the same rules.
- **FR-002**: Eligibility MUST include PDF content type, download filename, or `.pdf`
  path and MUST apply only to GET navigations.
- **FR-003**: The application MUST exclude POST responses, small embedded frames, and
  its own origin from ordinary capture.
- **FR-004**: Every stored PDF MUST carry source URL, capture time, and original
  SHA-256 inside the PDF.
- **FR-005**: Capture failure MUST be visible and MUST provide a native-open action.
- **FR-006**: The application MUST retain a local copy when source verification or
  recovery fails.
- **FR-007**: Recovery and rebuild MUST try the original source before known mirrors
  without silently replacing the paper.
- **FR-008**: Each browser integration MUST expose its enabled or disabled capture
  status to the user.
- **FR-009**: A successful browser capture in a Wayland session MUST focus or raise
  the Math PDF Reader window when the desktop permits it. If Wayland cannot focus
  or raise the window, the desktop runtime MUST report an actionable focus failure
  without treating the capture itself as failed. Other desktop sessions are out of
  scope for reader-window focus behavior.

### Key Entities
- **Captured PDF**: Local paper with embedded provenance and file identity.
- **Source Location**: Original URL or mirror with verification state.

## Success Criteria *(mandatory)*
### Measurable Outcomes
- **SC-001**: 100% of eligible PDF fixtures in both browsers are captured or reported
  with an actionable error.
- **SC-002**: 100% of captured fixtures retain source URL, capture time, and SHA-256
  after restart and reindexing.
- **SC-003**: At least 95% of fixtures classified as recoverable in the recovery
  validation corpus (fixtures with at least one source serving bytes matching the
  original SHA-256) reopen from the original source or a mirror.
- **SC-004**: 0% of failed captures are silently dropped.
- **SC-005**: 100% of Needs Re-fetch rebuild tests try the original URL once before
  trying mirrors in stored order.
- **SC-006**: 100% of Wayland capture tests either focus the reader window or report
  an actionable focus failure; non-Wayland sessions are excluded from this metric.

## Assumptions
- The supported browser integrations are Chrome and Firefox.
- A local copy is retained even when every remote source is unavailable.
- Browser navigation interception is limited to GET-style document navigations.
- Wayland is the only supported desktop session for reader-window focus behavior.
