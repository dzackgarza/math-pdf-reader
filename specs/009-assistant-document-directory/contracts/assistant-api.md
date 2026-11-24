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
