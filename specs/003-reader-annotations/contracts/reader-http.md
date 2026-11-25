# Reader HTTP Contract

The reader uses these loopback routes. `<origin>` is `http://127.0.0.1:<port>`.

| Route | Answer | Owner |
| --- | --- | --- |
| `GET /read/{key}` | 200 HTML reader page; 404 `unknown_item` for a key with no stored PDF | `server/src/app.rs` `read` |
| `GET /pdf/{key}.pdf` | 200 `application/pdf`, `ETag` = SHA-256 of the bytes, `X-Pdf-Edition` = base64url JSON of the item's provenance; byte ranges supported | `server/src/app.rs` `pdf` |
| `PUT /api/items/{key}/pdf` | body: the exported PDF; header `If-Match` required | `server/src/library.rs` `replace_pdf` |
| `PUT /api/items/{key}/reading` | body `ReadingRequest` `{page, pages, zoom, edition}` | `server/src/library.rs` `reading` |

## Reader page

The page head carries, for the Zotero Connector:

- `citation_title`: the item's title. The page script updates it when the title changes.
- `citation_author`: one tag per author, in order.
- `citation_pdf_url`: `<origin>/pdf/{key}.pdf`.

The body holds `<div id="reader" data-key="{key}">`. The fragment `#page=N` (N a positive
integer) opens page N. Each page change replaces the fragment with the page shown.

## Saving annotations

| Request | Answer |
| --- | --- |
| no `If-Match` | 428 Precondition Required |
| `If-Match` names bytes that are no longer stored | 412 `stale_pdf`, `ETag` of the stored bytes |
| PDF without the item's embedded provenance | 409 `provenance_mismatch` |
| body is not a PDF | 400 `not_a_pdf` |
| key with no stored PDF | 404 |
| accepted | 200, `ETag` of the saved bytes, the updated item |

The reader sends the next save with the `ETag` of the last accepted save.

## Recording the page

| Request | Answer |
| --- | --- |
| `page > pages` | 400 invalid |
| `edition` differs from the stored provenance | 409 `stale_pdf` |
| accepted | 200, the library payload |
