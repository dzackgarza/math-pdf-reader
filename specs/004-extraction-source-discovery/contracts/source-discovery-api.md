# Source Discovery API Contract

## Search

`POST /api/items/{key}/arxiv`

Returns ranked candidates with a visible threshold. Candidates below the threshold are not
returned.

## Promotion

`POST /api/items/{key}/arxiv/promote`

The body is one returned candidate. The server validates the candidate again, fetches the
arXiv PDF, preserves the original item, and returns:

```json
{
  "key": "1211.6367",
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
    "preferredKey": "1211.6367",
    "discoveredSourceUrl": "https://arxiv.org/pdf/1211.6367",
    "promotedAt": "2026-11-22T12:00:00.000Z"
  }
}
```

The resulting library state must show both items with the same `sourceLineage`:

```json
{
  "originalKey": "captured-item",
  "originalProvenance": {
    "pdf_url": "https://example.org/paper.pdf",
    "captured_at": "2026-11-22T11:00:00.000Z",
    "original_sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "title_hint": "Captured paper"
  },
  "preferredKey": "1211.6367",
  "discoveredSourceUrl": "https://arxiv.org/pdf/1211.6367",
  "promotedAt": "2026-11-22T12:00:00.000Z"
}
```

The promoted item is the only preferred working representation and its provenance URL is
the arXiv PDF URL. The original item remains an alternate and retains its embedded URL,
capture time, and original SHA-256. A repeated request for the same identifier/version
returns the existing preferred item with `existing: true`. If its PDF is missing,
`missing: true` directs the user to rebuild it. A failed request returns the
repository error contract and must not claim promotion success or leave an unlinked item.

For deterministic integration tests, the server accepts test-only configured Atom/PDF
endpoints that serve an arXiv-shaped fixture. Production requests still require HTTPS
`arxiv.org` or `export.arxiv.org`.

## Extraction Eligibility

The extraction manifest and server expose arXiv LaTeX only when the selected item has
eligible arXiv source provenance or a persisted confident promotion lineage. Non-arXiv items
expose only configured OCR/document-structure providers.
