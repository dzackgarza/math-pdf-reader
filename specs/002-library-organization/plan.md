# Implementation Plan: Library Organization

> Tier: feature
> Parent feature: `FEATURE-PDF-BUCKET`; roadmap `PLAN-PDF-BUCKET-ROADMAP`, milestone M2 (#7)

**Branch**: `002-library-organization` | **Date**: 2026-11-25 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-library-organization/spec.md`

## Summary

The library shows every stored PDF, filters it, files it into nested collections and tags,
keeps saved searches, and shows the details of one PDF in the inspector. Most of this was
built in M2 before the spec existed. This plan records the architecture in the source and
the gaps between the source and the spec. The gaps are in `tasks.md`, Phase 7 (Convergence).

The filing (collections, saved searches, per-item tags, collections, notes, reading state
and activity) is one JSON document, `organization.json`, at the store root. The Rust server
owns all writes to it. The React library UI reads one payload (`GET /api/library`) and
derives every view from it on the client. A view is never stored, so a view always agrees
with the current payload.

## Technical Context

**Language/Version**: Rust 2024 (axum server), TypeScript (React 19 UI, zod contracts), Bun

**Primary Dependencies**: axum, serde; React, TanStack Table, Radix UI, lucide-react; zod
(contracts in `src/contract/library.ts`, Rust types generated from them)

**Storage**: the store directory: one PDF per key with embedded provenance, and
`organization.json` for the filing

**Testing**: `bun test` with the real server: `tests/library-api.test.ts` (HTTP API) and
`tests/library-e2e.test.ts` (Puppeteer against the built library UI)

**Target Platform**: Linux desktop (Tauri window with the in-process server on 127.0.0.1)

**Project Type**: desktop app (Rust server plus web UI)

**Performance Goals**: none stated by the spec

**Constraints**: the library is local to one user; filing edits are deltas so two windows
editing from the same stale copy both land

**Scale/Scope**: one personal library; activity keeps the latest `ACTIVITY_KEPT` entries

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Reason |
| --- | --- | --- |
| I. Provenance travels with the PDF | Pass | The library reads provenance back from each PDF (`tests/library-api.test.ts:106`). The filing never holds provenance. |
| II–V (extraction, sources, assistant) | Not affected | This feature reads extraction state for display only. |
| Development Workflow: failing focused test first | Applies to Phase 7 | Each open task starts with a failing test through the library UI or the HTTP API. |
| Development Workflow: installed app verification | Applies to Phase 7 | User-visible changes are verified with `just provision` and the app on port 8770. |
| AGENTS.md invariant 7 (wiring only) | Pass | The table, sidebar and inspector are the reused library components; no new component is needed for the gaps. |

## Project Structure

### Documentation (this feature)

```text
specs/002-library-organization/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── library-organization-api.md
└── tasks.md
```

### Source Code (repository root)

```text
src/contract/library.ts          # BucketItem, Collection, Rule, SavedSearch, Activity, payload
server/src/library.rs            # /api/library, filing, collection and saved-search routes
server/src/organization.rs       # organization.json edits: filing, subtree, delete repair, activity
server/src/send.rs               # Keep offline: an item stays after a send (`leave`)
src/web/librarySelectors.ts      # views, quick filters, rule evaluation, availability
src/web/smartRules.ts            # rule editor helpers
src/web/routes.ts                # hash routes for views and organization pages
src/web/App.tsx                  # loading state and failed-load alert
src/web/Workspace.tsx            # library screen, empty table, missing list, unreadable notice
src/web/components/LibraryBar.tsx         # quick filters with counts
src/web/components/Sidebar.tsx            # Library, Collections, Topics, Tags, Saved Searches
src/web/components/LibraryTable.tsx       # table cells, Status badge (Cached / Offline)
src/web/components/EmptyTable.tsx         # empty states of the table
src/web/components/MissingList.tsx        # Needs Re-fetch list
src/web/components/InspectorPanel.tsx     # details: header, Sources, filing pickers
src/web/components/CollectionCards.tsx    # collection cards with counts and pins
src/web/components/SmartCollectionDialog.tsx
src/web/screens/OrganizationScreen.tsx    # collection page, tags, topics, saved searches
tests/library-api.test.ts
tests/library-e2e.test.ts
```

**Structure Decision**: no new modules. Each gap in Phase 7 changes one of the files above.

## Design

### Views

`LibraryView` in `src/web/librarySelectors.ts` has the kinds all, unfiled, unread, recent,
offline, missing, collection, tag and saved. `itemsInView` computes each view from the
payload:

| View | Membership |
| --- | --- |
| unfiled | `collections.length === 0` |
| unread | `reading.status === "unread"` |
| recent (Added This Week) | `dateAdded` within the last 7 days |
| offline | `availability(item) === "offline"`: the PDF URL is dead or serves other bytes and no mirror serves the PDF |
| missing (Needs Re-fetch) | not library items; `MissingList` renders `payload.missing` |
| collection | items in the collection or any subcollection (`collectionSubtree`) |
| tag | items whose tags include the tag |
| saved | `itemsMatching`: rules combined by `all` or `any` |

Rules are evaluated on each render from the current payload. A metadata edit changes the
payload, so saved-search membership follows it with no stored membership list.

### Filing

The server applies tag and collection edits as deltas (`/api/bulk/tags`,
`/api/bulk/collections`). A single-item edit uses the same routes. Collection deletion
removes the subtree, unfiles its items and repairs every saved search that names a deleted
collection (`delete_collection` in `server/src/organization.rs`). Tags are strings on items,
not entities, so removing a tag from its last item leaves any rule that names it in place.

Topics are tags with the prefix `topic:` (`TOPIC_PREFIX`). "Smart Collection" in the UI is a
saved search with rules (roadmap Decision Log, M2 label mapping).

Keep offline is a collection field. Its only effect is in `send.rs`: after a send to
Zotero, an item in a Keep offline collection (directly or through a subcollection) stays in
the bucket.

### Inspector

The header shows the title, the authors and year when present, the abstract when present,
the PDF URL's site as a link, the capture date and the file size. `Sources` shows the PDF
URL with its last check, the capture lineage, mirrors with Add mirror, and Verify. The table's
Status column shows Cached or Offline.

## Gaps against the spec

| Requirement | Gap | Class |
| --- | --- | --- |
| US1/AC2, SC-002 | An empty quick filter shows the generic "Empty" | partial |
| FR-007, US3/AC1 | The inspector shows no SHA-256, no file path and no cache state | partial |
| FR-008, SC-004, US3/AC2 | Missing authors, year and abstract are hidden, not marked missing | partial |
| US2/AC3, SC-005 | No test shows membership following a metadata edit | partial |
| FR-002 recent, FR-004 tag filter, edge cases | Code exists; no test through the real path | partial |

## Risks

- `tests/library-e2e.test.ts` shares one bucket across its tests. A test filtered with `-t`
  can fail because an earlier test did not create its fixture state (for example the
  "Quadratic forms" collection, or a viewed item for the Unread filter). New e2e tests for
  this feature create the state they need.

## Decision Log

- 2026-09-24 (user, #17, roadmap Decision Log): "Inbox is named Unfiled", and a reading app
  shows no permanent explanatory prose. The spec follows this decision.
- 2026-09-23 (M2, roadmap Decision Log): the mockups' "Smart Collection" is a saved search.
  FR-006 "collections support rules" is met by smart collections.
- Mockup term "Inbox" is noted here once, as AGENTS.md requires for a label mismatch.
