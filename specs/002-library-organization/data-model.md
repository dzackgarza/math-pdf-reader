# Data Model: Library Organization

All schemas are in `src/contract/library.ts`. The Rust types are generated from them. The
filing is stored in `organization.json` at the store root. The index is derivable from the
PDFs; the filing is not, and losing it leaves every PDF and its provenance intact
(`tests/library-api.test.ts:319`).

## Paper (`BucketItemSchema`)

| Field | Meaning | Source |
| --- | --- | --- |
| `id` | the store key; stable identity | store directory name |
| `title`, `titleSource` | title and where it came from (manual, resolver, guess, ...) | PDF metadata |
| `authors`, `year`, `abstract` | bibliographic fields; `year` and `abstract` may be null | PDF metadata |
| `provenance` | PDF URL, capture time, original SHA-256 | embedded in the PDF |
| `file` | `path`, `sizeBytes` | store |
| `tags`, `collections`, `notes`, `reading`, `mirrors`, `sourceCheck` | filing state | `organization.json` |
| `dateAdded` | the capture time | provenance |
| `extraction`, `zotero` | read-only for this feature | store, send |

`reading` is `{status: "unread"}` or `{status: "viewed", page, pages, viewedAt}`.

## Collection (`CollectionSchema`)

`id`, `name`, `parentId?`, `description`, `pinned`, `keepOffline`. A collection with
`parentId` is a subcollection. A collection view holds the items of its whole subtree.
Deleting a collection deletes its subtree.

## Tag

A string on an item. A tag with the prefix `topic:` is a topic. Tags are trimmed and
non-empty; the server refuses others (`tests/library-api.test.ts:423`).

## Saved Search (`SavedSearchSchema`)

`id`, `name`, `match` (`all` or `any`), `rules` (at least one). A rule
(`RuleSchema`) is on one field: text, title, author, tag, topic, collection, source, added,
reading or status. A rule that names a collection must name an existing one.

## Activity (`ActivitySchema`)

Entries of kind `created`, `filed`, `tagged` and `keptOffline`, each with `collectionId` and
`at`. The server keeps the latest `ACTIVITY_KEPT` entries.

## Library payload (`LibraryPayloadSchema`)

`items`, `missing` (items the index export holds whose PDF is lost), `collections`,
`savedSearches`, `activity`, `preferences`, `unreadable` (stored files that are not
readable PDFs).
