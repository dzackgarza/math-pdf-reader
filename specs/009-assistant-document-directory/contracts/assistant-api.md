# Contracts: Assistant Document Directory

## Bucket API

`POST /api/ai/session` keeps its existing request and response:

```json
{ "key": "1603.04246" }
```

The response still contains `pairUrl` and `sessionUrl`. Before responding, the server
ensures the stored paper's document directory exists and its chat is located there.

`GET /api/ai/pdf-text/{key}?page=N` remains unchanged. It returns only page N of the
original PDF as plain text. It does not require or represent an extraction.

`GET /api/ai/view/{key}` returns the exact recorded reader page and the absolute raw-page
address. It does not enumerate extraction or metadata resources.

`GET /api/ai/text/{key}` is removed. Clients read extraction files from the paper's
document directory instead.

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

The reader may list, glob, grep and read beneath the store root and fetch only the
bucket origin. It cannot run commands, edit files, start subagents or fetch arbitrary
web addresses. No rule names an individual extraction or metadata file.

## Extraction lifecycle

Successful placement writes into the existing document directory. The bucket does not
call an OpenCode refresh endpoint. The existing chat discovers current files by reading
its working directory on a later turn.
