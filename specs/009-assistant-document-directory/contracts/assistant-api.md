# Contracts: Assistant Document Directory

## Bucket API

`POST /api/ai/session` keeps its existing request and response:

```json
{ "key": "1603.04246" }
```

The response still contains `pairUrl` and `sessionUrl`. Before responding, the server
ensures the stored paper's document directory exists and its chat is located there.

For reader page context see the [page-context contract](../../005-assistant-page-context/contracts/assistant-api.md).

## Private OpenCode API

New chat:

```http
POST /api/session
Content-Type: application/json

{
  "location": { "directory": "/absolute/store/root/1603.04246" },
  "title": "Paper title",
  "agent": "reader"
}
```

Existing chat at another location:

```http
POST /api/session/{sessionID}/move
Content-Type: application/json

{ "directory": "/absolute/store/root/1603.04246", "delivery": "steer" }
```

A missing existing session is created again under the same key mapping. A move failure
is an assistant availability error; the bucket does not silently reuse the old location.

## Reader agent capabilities

The session's location is the paper directory. The assistant chooses its own file
and shell tools to inspect the PDF, Markdown, LaTeX or other files there. A file
added later is available on the next turn without an instruction update.

The reader supplies the displayed page number through `GET /api/ai/view/{key}`.
Its optional text-layer snippet is a labeled search hint. The assistant uses the
hint to locate a passage and reads the paper artifact before answering.

## Extraction lifecycle

Successful placement writes into the existing document directory. The bucket does not
call an OpenCode refresh endpoint. The existing chat discovers current files by reading
its working directory on a later turn.

The bucket checks the input PDF's embedded provenance before it publishes an
extraction. If another paper now has the same key, the request returns
`409 store_failed`. If publication fails, the previous Markdown and its
artifacts remain available. Renaming the rollback journal out of its active
location commits the new extraction. A process stop before that rename restores
the previous pair on startup. A process restart after the rename keeps the new pair.

A chat belongs to the captured paper. Reopening that paper retains its chat.
Deleting it and capturing a different paper under the same key starts a new chat.
A legacy mapping that contains only a session ID gives no evidence of paper
identity. The first open creates a conversation bound to the current PDF's
provenance. The earlier conversation stays in OpenCode. Page updates go only to
a conversation whose recorded provenance matches the current paper.

## Source and hint failures

Session open returns `404 unknown_item` for a missing current PDF and
`422 unreadable_pdf` with the file diagnostic for a damaged current PDF. When only
the optional hint fails, the view and chat entry retain the exact recorded page
and identify the hint failure. Opening the session still succeeds.
