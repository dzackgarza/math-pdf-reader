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
`tests/library-e2e.test.ts` (Puppeteer against the built library UI). Each e2e test starts its
own server over a fresh library and its own Chromium, and seeds the filing and reading state it
needs through the HTTP API, so a test runs alone with `-t`.

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

A view with no rows says "No PDF matches <view name>" (`viewName`: the quick filter, collection,
tag label or saved search). An empty library says "No PDFs yet", and a search that excludes
every row says "No matches" with Clear search. An empty Needs Re-fetch says "Every PDF is in the
library."

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

The header shows the title, the authors and the year, the abstract, the PDF URL's site as a
link, the capture date and the file size. Missing authors, year or abstract show as "No
authors", "No year" and "No abstract" in muted italics, never as an empty line. The first
page has a fixed height: the image loads after the panel draws and must not push the fields
down. The details list Cache status (Cached or Offline, from `availability`, with the last
check as its tooltip), File path (`item.file.path`) and SHA-256 (the original bytes'
`provenance.original_sha256`). `Sources` shows the PDF URL with its last check, the capture
lineage, mirrors with Add mirror, and Verify. The table's Status column shows the same Cached
or Offline.

### Window state

`src/web/Workspace.tsx` holds the library window's state once the library has loaded: the
sidebar, the screen that the address names, the inspector of the selected PDF, the status
bar, and the dialogs and palettes. The panels only draw that state.

- The table shows the items of the view that the address names. A screen with no table, or
  an address that names a deleted collection or saved search, has no view.
- When a read of the library fails after the first one, the window keeps what it shows and
  says that the data is old. Files in the library folder that the store cannot read are
  listed by name with the reason; all other items still show.
- The theme is the root element's `data-theme`; `index.css` resolves each colour from it.
- Each dialog opens with new fields from its request, not from the last dialog.
- An empty note draft is removed, so an item with no stored draft has an empty one.
- Each key that the window acts on comes from the current payload's items; an unknown key is
  an error.
- A new PDF's Retrieve metadata runs after its capture or import answers. The library then
  shows the title it found, or says what it could not do (start Zotero, identify an item).
- A row among the checked rows acts for all checked rows; another row acts only for itself.
  The menu of an item that left the library (deleted in another window) closes.
- A PDF's tab offers its item's menu and shows and runs its extraction, from the current
  library, plugins and runs.
- A message (failure, shortfall, progress or notice) shows at the lower left of the library
  pane, never over the sidebar or the inspector. When the inspector overlays the pane on a
  narrow window, the message stops at the inspector's edge, so Open and Send to Zotero stay
  usable while it shows.

### Library actions

`src/web/libraryActions.ts` holds what the window's controls do. Each action asks for what it
needs (a name, a confirmation), calls the library API, and moves to the result.

- Tags and collections change through the bulk add and remove routes, for one item or many.
  A change names only what it adds or removes, so two changes made from old copies of the
  library both take effect. Each text the user typed is trimmed before it is sent.
- A failed call leaves the library as the server holds it, and the window says what refused
  it. A call that succeeded but could not do all of its work (a PDF not restored, no item
  that Zotero identified) is reported as a shortfall. A call that succeeded shows a notice
  when the library does not show the result by itself.
- New Collection creates the collection and files the chosen items in it; the filing answer
  is the library, which then holds the new collection.
- Rebuild reports, for each item that no URL serves, each URL tried and what it served. It
  runs for one lost PDF or for all of them in one request.
- Delete closes the item's reader tab once its annotations are saved, then deletes the item.
  Deleting a collection or saved search asks first and leaves its page.
- Retrieve metadata is Zotero's "Retrieve Metadata": Zotero resolves the item's URL, and
  its answer gives the title. The outcome reports what it could not do, or nothing when
  Zotero resolved the item.
- Import URL and Add Folder each ask for one line, store what they find and show the new
  item; Add Folder reports how many PDFs were new.
- Saving a smart collection creates a new one (id null), which then opens, or saves the one
  with that id.
- A successful extraction placed files beside the PDF, so the library is read again: the
  item's extraction comes from those files.

## Gaps against the spec

| Requirement | Gap | Class |
| --- | --- | --- |
| US2/AC3, SC-005 | No test shows membership following a metadata edit | partial |
| FR-002 recent, FR-004 tag filter, edge cases | Code exists; no test through the real path | partial |

## Decision Log

- 2026-09-24 (user, #17, roadmap Decision Log): "Inbox is named Unfiled", and a reading app
  shows no permanent explanatory prose. The spec follows this decision.
- 2026-09-23 (M2, roadmap Decision Log): the mockups' "Smart Collection" is a saved search.
  FR-006 "collections support rules" is met by smart collections.
- Mockup term "Inbox" is noted here once, as AGENTS.md requires for a label mismatch.
