# Assistant HTTP Contract

All routes are served by the local bucket. The route parameters use the existing item
key and API error schema. These routes do not write to Zotero.

## Open or reuse an assistant session

`POST /api/ai/session`

Request body: `{ "key": "<item-key>" }`.

Success returns the existing assistant-session schema, including the OpenCode pairing
and chat URLs. The server creates a paper-specific workspace, writes its source
instructions and updates its reader-view entry. No extraction is required.

Failures remain visible as the existing API errors, including `ai_unavailable` when the
private assistant server cannot start or answer.

## Read one raw-PDF page

`GET /api/ai/pdf-text/{key}?page={page}`

- `page` is required and 1-based.
- Success is `200 text/plain; charset=utf-8` with one page marker and that page's text.
- An absent, malformed or out-of-range page is a client error.
- An unknown item or unreadable PDF remains an explicit server error.
- No structured extraction is required and no extraction file is created.

## Read authoritative extraction text

`GET /api/ai/text/{key}`

Returns the authoritative extraction as text. Document-structure and OCR extractions
serve `<key>.md`; arXiv LaTeX serves `<key>.extraction/source.tex`.

A missing or non-authoritative extraction is a client error that explicitly says no
structured extraction is available. Supplying `page` is a client error: page-specific
raw text belongs to `/api/ai/pdf-text/{key}`.

## Read current page context

`GET /api/ai/view/{key}`

Returns the exact reader page, its raw-page text address and, when available, the
authoritative-extraction address with a search hint. It does not return inferred
extraction line ranges. It can state that no page has been recorded.

## Context refresh caused by extraction

The existing `POST /api/items/{key}/extractions/{plugin-id}` contract is unchanged. On
success, the server also refreshes an existing assistant workspace and reader-view
entry for the same key. It does not start an assistant for a paper with no assistant
workspace.
