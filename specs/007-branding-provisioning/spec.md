# Feature Specification: Math PDF Reader Identity and Provisioning

**Feature Branch**: `007-branding-provisioning`
**Created**: 2026-11-22
**Status**: Draft
**Input**: Existing branding, launch, provisioning, and browser-extension lifecycle behavior

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See one product identity (Priority: P1)

The user sees “Math PDF Reader” consistently in the application, launcher, desktop
entry points, and user-facing documentation.

**Independent Test**: Inspect visible application surfaces and launch the installed
application from each supported entry point.

**Acceptance Scenarios**:
1. **Given** any user-facing application surface, **When** it is opened, **Then**
   the product is named Math PDF Reader.
2. **Given** an existing compatibility identifier, **When** the application uses it
   internally, **Then** it does not leak as the product name.

### User Story 2 - Launch the current build (Priority: P1)

The user can start the application normally and receive a visible build failure
instead of an old or silently broken runtime.

**Independent Test**: Launch with unchanged and changed application sources, including
an intentional build failure.

**Acceptance Scenarios**:
1. **Given** application sources changed, **When** the normal launcher runs, **Then**
   it rebuilds the application before opening it.
2. **Given** the rebuild fails, **When** the user launches, **Then** visible build
   output remains available and the stale application is not presented as current.
3. **Given** only browser-extension sources changed, **When** the application
   launches, **Then** extension provisioning is not silently required by the app build.

### User Story 3 - Update browser integrations separately (Priority: P2)

The user can provision browser extensions through an explicit extension workflow
without coupling extension changes to ordinary application startup.

**Independent Test**: Change only extension sources and run the extension workflow;
then start the application without running that workflow.

**Acceptance Scenarios**:
1. **Given** an extension change, **When** extension provisioning is run, **Then**
   the affected browser builds are updated.
2. **Given** no extension provisioning has run, **When** the app starts, **Then**
   application-only startup remains independent and reports extension status clearly.
3. **Given** an enabled extension whose installed version differs from the provisioned
   version for that browser, **When** the user navigates to an eligible PDF, **Then**
   the extension refuses capture and shows how to replace it.
4. **Given** the user installed the matching extension, **When** they repeat the same
   navigation with capture enabled and the bucket running, **Then** the bucket
   stores the PDF and opens its reader.

### Edge Cases
- A changed build may fail before the desktop window opens.
- An installed runtime may differ from the checkout until the normal launcher updates it.
- Internal compatibility names may remain in paths or identifiers without being shown
  to users.

## Requirements *(mandatory)*
### Functional Requirements
- **FR-001**: User-facing product surfaces MUST use the name Math PDF Reader.
- **FR-002**: Internal compatibility identifiers MAY remain only where required and
  MUST NOT determine the visible product name.
- **FR-003**: The normal launcher MUST detect changed application inputs and install
  the current application build before startup.
- **FR-004**: Build failures MUST be visible and MUST prevent a stale build from
  being presented as current.
- **FR-005**: Application provisioning MUST exclude extension-only inputs.
- **FR-006**: Browser-extension provisioning MUST be a separate explicit workflow.
- **FR-007**: The user MUST be able to identify whether the application and browser
  integrations are current.
- **FR-008**: Chrome and Firefox MUST each refuse capture on a version mismatch and
  identify the replacement for that browser.

### Key Entities
- **Application Build**: Installed user-facing desktop runtime.
- **Extension Build**: Browser-specific capture integration.
- **Provisioning State**: Current, stale, or failed state for each build family.

## Success Criteria *(mandatory)*
### Measurable Outcomes
- **SC-001**: 100% of tested user-facing surfaces display Math PDF Reader.
- **SC-002**: 100% of launch tests with changed application sources run the current
  build before opening the app.
- **SC-003**: 100% of intentional build failures remain visible and block stale startup.
- **SC-004**: Extension-only changes trigger no application provisioning in 100% of
  app-start tests.
- **SC-005**: In each browser, navigation with a mismatched extension leaves the
  fixture PDF absent from the bucket and exposes replacement instructions. After
  replacement, the same fixture appears in the bucket and opens in the reader.

## Assumptions
- The installed application is separate from the source checkout.
- The normal launcher is the supported path for user-visible application updates.
- Browser extension signing or installation constraints remain external to this spec.
