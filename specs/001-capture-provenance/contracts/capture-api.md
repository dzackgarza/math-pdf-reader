# Capture API Contract

## `POST /capture-bytes`

Firefox and direct upload clients submit a multipart form:

- `pdf`: PDF file bytes
- `pdf_url`: source URL
- `title_hint`: non-empty display hint

Success returns the shared `CaptureResponse`. Invalid input or storage failure
returns an explicit error and does not publish `open-reader`.

## `POST /capture-download`

Chrome submits JSON:

```json
{
  "path": "/path/to/saved/file.pdf",
  "filename": "paper.pdf",
  "pdf_url": "https://example.test/paper.pdf",
  "title_hint": "Paper"
}
```

The server reads the saved file, applies the same provenance/storage path as
`/capture-bytes`, and returns the same `CaptureResponse`.

## `POST /api/import-url`

Send JSON with the source `url` and a required boolean `open_reader`. The server
fetches the PDF and applies the same provenance embedding, hash validation and
durable storage as browser capture. On success it returns `{ key, existing }`.

| Request | Expected result |
| --- | --- |
| `open_reader: false` | The paper is available at its stored key. The import emits no `open-reader` event. |
| `open_reader: true` | The paper is available at its stored key. The import emits `open-reader` with that paper's reader URL and title. |

## `GET /api/events`

Successful capture emits:

```json
{
  "event": "open-reader",
  "data": {
    "reader_url": "http://127.0.0.1:8770/read/<key>",
    "title": "Paper"
  }
}
```

The library opens the reader URL; the Tauri shell brings the window forward. A
missing listener does not invalidate the stored capture. Focus is a desktop-shell
concern and is not encoded as a success or failure field in `open-reader`.

For Wayland sessions, the desktop shell MUST catch failures from showing,
unminimizing, or focusing the window and expose an actionable focus-failure
status to the library UI. A focus failure MUST NOT turn an already stored
capture into a capture failure. Other desktop sessions are outside this focus
contract.

## Recovery endpoints

- `POST /api/items/{key}/verify`
- `POST /api/items/{key}/rebuild`
- `POST /api/rebuild`
- `POST /api/items/{key}/mirrors`
- `DELETE /api/items/{key}/mirrors?url=...`

Rebuild must try the embedded provenance URL before mirrors and accept only a
matching original SHA-256.
