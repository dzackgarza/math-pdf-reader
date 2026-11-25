# Contract: Library Organization API

Routes are in `server/src/library.rs` (router at line 528). Bodies and responses use the
schemas in `src/contract/library.ts`. Errors use `ApiErrorSchema` with an `error.kind`.

| Method and path | Body | Effect | Errors |
| --- | --- | --- | --- |
| `GET /api/library` | none | the `LibraryPayload` | none |
| `PUT /api/items/{key}/reading` | `page`, `pages`, `edition` | records the last viewed page; not a filing change | 400 page out of range, 404 unknown item |
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
