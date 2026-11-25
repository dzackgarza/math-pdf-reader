# Contract: Library Organization API

Routes are in `server/src/library.rs` (router at line 528). Bodies and responses use the
schemas in `src/contract/library.ts`. Errors use `ApiErrorSchema` with an `error.kind`.

| Method and path | Body | Effect | Errors |
| --- | --- | --- | --- |
| `GET /api/library` | none | the `LibraryPayload` | none |
| `PUT /api/items/{key}/reading` | `page`, `pages`, `zoom`, `edition` | records the last viewed page and zoom; not a filing change | 400 page out of range, 404 unknown item |
| `PATCH /api/items/{key}/metadata` | bibliographic fields | writes them into the PDF | 404 unknown item |
| `POST /api/bulk/tags` | `keys`, `add`, `remove` | tag delta on each item | 400 `invalid_request` (blank, untrimmed, no keys), 404 `unknown_item` |
| `POST /api/bulk/collections` | `keys`, `add`, `remove` | collection delta on each item; logs `filed` | 400 `unknown_collection`, 404 `unknown_item` |
| `POST /api/collections` | `name`, `parentId?` | creates a collection; logs `created` | 400 `unknown_collection` (parent) |
| `PATCH /api/collections/{id}` | any of `name`, `description`, `pinned`, `keepOffline` | updates it; logs `keptOffline` | 400 empty body, 404 unknown collection |
| `DELETE /api/collections/{id}` | none | deletes the subtree, unfiles its items, repairs saved searches | 404 unknown collection |
| `POST /api/saved-searches` | `name`, `match`, `rules` | creates a saved search | 400 no rules, 400 `unknown_collection` |
| `PUT /api/saved-searches/{id}` | `name`, `match`, `rules` | replaces it | 404 unknown saved search |
| `DELETE /api/saved-searches/{id}` | none | deletes it | 404 unknown saved search |

Tag and collection edits are deltas, so two edits made from the same stale copy both land
(`tests/library-api.test.ts:479`).

## How the window reports a failed action

The alert names what refused: the app's server with its `error.kind`, the app not
answering, a desktop plugin, the browser (for example the clipboard, with the
`DOMException` name), or a defect in the window's own code (an answer that does not parse).
An answer that is not the app's error document (a proxy, a crash) has no kind and shows its
HTTP status. A Tauri plugin rejects with its error as a string: tauri-plugin-opener and
tauri-plugin-dialog serialize their `Error` with `serialize_str`.

The status bar shows, on hover, whether browser captures can land. A refused or failed
index export, and an unavailable Zotero, show their reason and what to do in the bar itself.
A failed storage check answers `/status` with the app's error document, whose message
carries the operating system's error; Settings shows it in each row that reads `/status`.
An old app build or a failed rebuild shows in the bar itself (`GET /api/app-build`, the
provisioning contract of 007).
