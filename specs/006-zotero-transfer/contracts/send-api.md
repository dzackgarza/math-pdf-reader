# Contract: Send API

The server routes are in `server/src/send.rs` (`routes`). The bodies are
`SendResponseSchema` and `SendAndExtractResponseSchema` in `src/contract/library.ts`.
Errors use `ApiErrorSchema`. The cross-origin guard (`server/src/guard.rs`) refuses each route
for a page on another site with `403 cross_origin_request`.

| Route | Body | Success |
| --- | --- | --- |
| `POST /api/items/<key>/zotero` | none | `200 SendResponse` |
| `POST /api/items/<key>/zotero/extracted` | none | `200 SendAndExtractResponse` |
| `POST /api/items/<key>/zotero/pdf-only` | none | `200 SendResponse`, `performed: ["pdf"]` |

| Error | When | Zotero contacted |
| --- | --- | --- |
| `409 already_sent` | A record exists with no step owed. For `/extracted`, the record is a standalone attachment. For `/pdf-only`, any record exists. | No |
| `409 pdf_only_refused` | `/pdf-only` on an item with notes or Markdown | No |
| `503 zotero_unavailable` | The health check (`GET /version`) fails: not running, no addon, or the addon lacks `import_store_attachments` | Health check only |
| `502 zotero_failed` | Zotero refused or did not answer a write or read after the health check, or answered JSON that does not match the documentation | Yes |
| `404` | No stored item has the key | No |

On every error the item stays in the library with its PDF. A `zotero_failed` error after
`import_from_url` leaves `zotero.status = "sent"` with the remaining steps in `pending`.

## Write API calls (Zotero side)

The client is `server/src/zotero.rs`. Calls: `GET /version`, `POST /write` with
`import_from_url`, `update_item_fields`, `attach_note`, `trash_item`, and `resolve_url` (for
Retrieve metadata, which saves nothing). Also `POST /attach`, and reads of
`/api/users/0/items/<key>/children` and `/file/view/url`. FR-005 adds
`get_selected_collection` and `collection_keys` on `import_from_url`.

## Send target

Each `SendResponse` names where the item is in Zotero after the send, in `target`:

| `target.kind` | When |
| --- | --- |
| `collection` | A collection is selected in Zotero's pane; `collectionKey` is its key. |
| `library` | The library root, or another row that is not a collection, is selected. |
| `earlier_send` | The send finishes an earlier send and files nothing. |

## Proof notes for `tests/server-send.test.ts`

- Zotero is a closed port, a replay of Zotero without the write API, or the loopback stub
  `tests/zotero-stub.ts`. No test writes to a real library.
- A send that contacts a closed Zotero port answers `503 zotero_unavailable`. So a `409`
  refusal against a closed port proves the send refused before the health check.
- A request under another host name, with `Sec-Fetch-Site: same-origin`, is what a page on a
  domain that resolves to 127.0.0.1 sends (DNS rebinding). `fetch()` writes the `Host` header
  from the URL, so the test sends it through `node:http`.
