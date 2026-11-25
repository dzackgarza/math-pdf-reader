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
`get_selected_collection` and `collection_keys` on `import_from_url`. For the send target it
reads the `collection_key` of a standalone attach answer and the collection's name from
`/api/users/0/collections/<key>`.

## Send target

Each `SendResponse` names where the item is in Zotero after the send, in `target`:

| `target.kind` | When |
| --- | --- |
| `collection` | A collection is selected in Zotero's pane; `collectionKey` is its key and `collectionName` its name. |
| `library` | The library root, or another row that is not a collection, is selected. |
| `earlier_send` | The send finishes an earlier send and files nothing. |

Send to Zotero takes the name from the `get_selected_collection` answer. Send PDF Only gets
only the key from the attach answer, so it reads the name from Zotero's local API after it
saves the send record and removes the item from the library. If that read fails, the send
answers the Zotero error, and the record shows that the PDF is in Zotero.

The library UI's message names the target: "in the collection “<name>”", "in My
Library", or "in the place an earlier send put it".

## Sends in the library UI (`src/web/libraryActions.ts`)

- A send first closes the item's reader tab once its annotations are saved, so the send
  carries them. While the send runs or after it fails, the inspector shows its state; a
  completed send takes the item out of the bucket.
- The three ways: Send to Zotero (to the Zotero item that the write API finds for the PDF
  URL), Send to Zotero and Extract (the same, then the configured chain of extraction
  plugins, whose Markdown it attaches), and Send PDF Only (the PDF alone, as a standalone
  attachment, for a PDF whose URL names no paper).
- After Send to Zotero and Extract, the message names the target and which plugin's
  Markdown went to Zotero. When no plugin extracted the PDF, the message is an alert, and the
  PDF is in Zotero all the same.

## Proof notes for `tests/server-send.test.ts`

- Zotero is a closed port, a replay of Zotero without the write API, or the loopback stub
  `tests/zotero-stub.ts`. No test writes to a real library.
- A send that contacts a closed Zotero port answers `503 zotero_unavailable`. So a `409`
  refusal against a closed port proves the send refused before the health check.
- A request under another host name, with `Sec-Fetch-Site: same-origin`, is what a page on a
  domain that resolves to 127.0.0.1 sends (DNS rebinding). `fetch()` writes the `Host` header
  from the URL, so the test sends it through `node:http`.

## The loopback Zotero stub (`tests/zotero-stub.ts`)

The stub is a loopback Zotero for tests that must not write to the user's library. It
answers in the shapes that the write API documents (the addon's `openapi.yaml`, 3.11.2) and
that Zotero's local API serves. It keeps the items and children that the requests make, and
it records each request (method, path with query, JSON body of a POST), so a test can read
what Zotero would hold and what the bucket asked for.

- `selection` is the row selected in Zotero's pane: a collection (key and name), a row that
  is not a collection (the library root or a saved search), or no row because no Zotero
  window is open (409 for each operation that reads the selection).
- `GET /api/users/0/collections/<key>` answers the selected collection with its name, and
  404 for any other key, as the local API does for an unknown key.
- `refuse` answers a request with Zotero's refusal (the write API's `ErrorResponse`) instead
  of the stub's own answer; `null` lets the stub answer.
- `writes()` lists each write the bucket asked for: each `/write` operation and each
  `/attach`.
