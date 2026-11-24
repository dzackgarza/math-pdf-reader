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

## Read one raw-PDF page

`GET /api/ai/pdf-text/{key}?page={page}`

- `page` is required and 1-based.
- Success is `200 text/plain; charset=utf-8` with one page marker and that page's text.
- An absent, malformed or out-of-range page is a client error.
- An unknown item or unreadable PDF remains an explicit server error.
- No structured extraction is required and no full-document PDF-text route is exposed.

## Read the current page context

`GET /api/ai/view/{key}`

Success returns the existing reader-view schema. Its text identifies the original PDF,
the raw-page address and the exact page reported by the reader. It can include a bounded
raw-text search hint. It does not enumerate extraction files or approximate extraction
line ranges.

A reader-page report updates the same instruction entry in an open chat. Placing an
extraction changes only the paper's document directory; it does not update this entry.

## Discover paper artifacts

The assistant uses generic read, directory-list, glob and grep capabilities beneath the
store root. Read, edit, shell and subagent permissions remain separate: the reader cannot
edit files, execute commands or start subagents. Paper artifacts need no dedicated HTTP
route, permission rule or instruction entry.
