# Source Discovery API Contract

## Search

`POST /api/items/{key}/arxiv`

Returns every candidate that the arXiv API returns for the paper's title terms, up to
five, ranked by score, each with its reasons. No score hides a candidate; the user chooses.

Errors use the repository error contract (`{ error: { kind, message } }`, `ApiError` in
`src/contract/library.ts`):

| Condition | Required response | Requirement |
| --- | --- | --- |
| The stored title is a placeholder (file name, "View PDF", "None", empty) | A client error that tells the user to set the title first; no request goes to arXiv | FR-018 |
| arXiv answers HTTP 429 or 503 | An upstream error whose message names arXiv and, when arXiv sends `Retry-After`, when to retry; the message does not contain the query URL | FR-017 |
| arXiv cannot be reached | An upstream error whose message names arXiv | FR-017 |

The `ApiError` kind list has no upstream kind now. T070 adds one to the shared contract.

## Promotion

`POST /api/items/{key}/arxiv/promote`

The body is one returned candidate. The server validates the candidate again,
fetches the arXiv PDF, replaces the paper under its existing key, and returns:

```json
{
  "key": "captured-item",
  "originalKey": "captured-item",
  "existing": false,
  "missing": false,
  "sourceLineage": {
    "originalKey": "captured-item",
    "originalProvenance": {
      "pdf_url": "https://example.org/paper.pdf",
      "captured_at": "2026-11-22T11:00:00.000Z",
      "original_sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "title_hint": "Captured paper"
    },
    "preferredKey": "captured-item",
    "discoveredSourceUrl": "https://arxiv.org/pdf/1211.6367",
    "promotedAt": "2026-11-22T12:00:00.000Z"
  }
}
```

The resulting library state shows one current item with this `sourceLineage`:

```json
{
  "originalKey": "captured-item",
  "originalProvenance": {
    "pdf_url": "https://example.org/paper.pdf",
    "captured_at": "2026-11-22T11:00:00.000Z",
    "original_sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "title_hint": "Captured paper"
  },
  "preferredKey": "captured-item",
  "discoveredSourceUrl": "https://arxiv.org/pdf/1211.6367",
  "promotedAt": "2026-11-22T12:00:00.000Z"
}
```

The paper keeps its key, filing, and reading state. Its current PDF has the arXiv
PDF URL as provenance. The captured URL, time, and original SHA-256 remain in
historical lineage embedded in that PDF. The old PDF and extraction leave the
active store after success. A repeated request for the same identifier/version
returns the current key with `existing: true`. A missing PDF requires recovery
through Needs Re-fetch. A failure before replacement leaves the captured paper intact.

If an earlier version created a linked pair, an explicit replacement can reuse
the linked arXiv PDF. Its embedded provenance identifies the captured paper.
The request reports a conflict if a separate arXiv copy has its own filing or
extraction that requires reconciliation. An independently captured PDF with the
same arXiv bytes also causes a conflict. In either case both papers stay available.

For deterministic integration tests, the server accepts test-only configured Atom/PDF
endpoints that serve an arXiv-shaped fixture. Production requests still require HTTPS
`arxiv.org` or `export.arxiv.org`.

## Extraction Eligibility

The extraction manifest and server expose arXiv LaTeX only when the selected item has
eligible arXiv source provenance or a persisted promotion lineage. Non-arXiv items
expose only configured OCR/document-structure providers.
