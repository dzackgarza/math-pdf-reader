# Assistant HTTP Contract

All routes are served by the local bucket. Route parameters use the existing item key
and API error schema. These routes do not write to Zotero.

## Open or reuse an assistant session

`POST /api/ai/session`

Request body: `{ "key": "<item-key>" }`.

Success returns the existing assistant-session schema, including the OpenCode pairing
and chat URLs. A new session uses `<root>/<key>/` as its location. An existing session
moves to that directory through OpenCode's session-move route and keeps its session ID.
No extraction or generated paper-source catalog is required.

Failures remain visible as the existing API errors, including `ai_unavailable` when the
private assistant server cannot start, move the session or answer.

## Read the paper and locate the current page

The session's location is the paper directory. The assistant chooses its own file
and shell tools to inspect the PDF, Markdown, LaTeX or other files there. A file
added later is available on the next turn without an instruction update.

The reader gets `X-Pdf-Edition` with the bytes from `GET /pdf/{key}.pdf`. It
decodes that base64url header as a JSON provenance object. To record a page,
it sends `{ "page": N, "pages": M, "edition": provenance }` to
`PUT /api/items/{key}/reading`. The edition belongs to the PDF on screen when
the page changed. If that edition has since been replaced, the server returns
`409 stale_pdf` and preserves the reading position and both chats.

`GET /api/ai/view/{key}` returns the recorded page for the assistant.
Its optional text-layer snippet is a labeled search hint. The assistant uses the
hint to locate a passage and reads the paper artifact before answering.

If the text layer cannot supply the optional hint for a valid paper, the page
context still returns the exact reported page. The view and chat identify the hint
failure separately. See the [session error contract](../../009-assistant-document-directory/contracts/assistant-api.md#source-and-hint-failures).
