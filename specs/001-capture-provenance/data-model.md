# Data Model: PDF Capture and Provenance

## Captured PDF

The durable local paper identified by a stable library key.

| Field | Constraints |
|---|---|
| `key` | Non-empty stable store identity; unique within the folder-backed store |
| `bytes` | Valid PDF bytes; retained even when source recovery fails |
| `stored_sha256` | SHA-256 of the stored bytes |
| `reader_url` | Stable local HTTP reader URL |
| `provenance` | Embedded `Provenance` record |
| `source_check` | Derived verification state for the original URL |
| `mirrors` | Zero or more `Source Location` records |

## Provenance

Embedded in the PDF and read back during indexing.

| Field | Constraints |
|---|---|
| `pdf_url` | Original fetched URL; valid URL |
| `captured_at` | Offset-aware timestamp |
| `original_sha256` | SHA-256 of the bytes at capture time |
| `title_hint` | Non-empty capture title hint |

The original URL and original hash are immutable capture identity. Later metadata
or mirror checks must not rewrite them.

## Source Location

A recoverable URL associated with a captured paper.

| Field | Constraints |
|---|---|
| `url` | Valid URL; unique per paper |
| `kind` | Original provenance URL or user-added mirror |
| `check` | `unchecked`, `accessible`, `changed`, or `dead`, with diagnostic detail |

Recovery orders the original provenance URL first, then mirrors in stored order.
Only bytes matching `original_sha256` may restore a missing PDF.

## Capture Request

Two browser-specific transport forms map to the same server operation:

- Firefox/body path: multipart `pdf`, `pdf_url`, and `title_hint`.
- Chrome/download path: JSON `path`, `filename`, `pdf_url`, and `title_hint`.

All URLs and title hints are validated before staging. Invalid requests return an
explicit client error and do not create a paper.

## Capture Response

`CaptureResponse` returns `key`, `existing`, `stored_sha256`, `reader_url`,
`pdf_url`, and embedded `provenance`. A successful response means the PDF has been
stored or an existing identical paper has been found.

## Capture and Recovery States

```text
browser navigation
  ├─ ineligible → browser-native handling
  └─ eligible GET
       ├─ capture success → stored/existing → open-reader event → reader tab
       └─ capture failure → visible error → native-open action

stored paper
  ├─ source unchecked/accessible → normal library item
  ├─ source changed/dead → Needs Re-fetch or explicit recovery
  └─ local bytes missing
       ├─ original URL hash match → restored
       ├─ mirror hash match → restored
       └─ no hash match/source unavailable → unrestored, local record retained
```

The state machine never turns a partial, mismatched, or unavailable result into a
successful capture.
