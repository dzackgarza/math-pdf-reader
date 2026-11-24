# Data Model: Structured Extraction and Source Discovery

## Extraction Job

Represents one requested provider execution.

| Field | Constraint |
|---|---|
| item key | Required stored item identifier |
| provider | Must name a provider declared in `plugins/manifests/extractions.json` |
| status | `queued`, `running`, `succeeded`, or `failed` |
| authoritative | True only for a provider output accepted by its contract |
| error | Required for `failed`; absent for successful jobs |

Failed jobs never create an authoritative extraction.

## Structured Extraction

Represents source-backed output stored beside a PDF.

| Field | Constraint |
|---|---|
| provider | Declared external command |
| status | Visible success/failure state |
| markdown | Single readable Markdown document derived from the main LaTeX file and its includes |
| source artifact | Required for arXiv LaTeX extraction |
| authoritative | Explicit state consumed by assistant context |
| files | Provider artifacts, never an unlabelled PDF text dump |

For arXiv, the source artifact is the LaTeX source itself. For non-arXiv items, the
provider must be a configured OCR or document-structure extractor.

## Source Candidate

One ranked arXiv discovery result.

| Field | Constraint |
|---|---|
| identifier/version | Must identify the arXiv paper/version |
| metadata | Title, authors, abstract, and year as available |
| PDF URL | Must be an arXiv PDF URL |
| confidence | Number in `[0, 1]`; promotion requires the configured threshold |
| reasons | Non-empty explanation of the score |

## Source Lineage

Durable relationship between the original captured item and a promoted source item.

| Field | Constraint |
|---|---|
| original item key | Required; original item remains present |
| preferred item key | Required after promotion |
| discovered source URL | Required arXiv URL |
| promoted at | Required timestamp |
| original provenance | Remains immutable on the original item |

Both linked items expose this lineage. The preferred item has arXiv provenance and may
expose the original URL as an alternate mirror. The original item remains visible but is
not preferred. Ordinary recovery of the original item remains hash-safe and unchanged.
Lineage writes are atomic with promoted-item placement, and an existing identifier/version
returns the existing preferred item rather than creating a duplicate.

## State Transitions

```text
captured non-arXiv item
  -> discovery candidates
  -> confident candidate selected
  -> promotion requested
  -> source fetched and verified as PDF
  -> preferred arXiv item stored/linked
  -> lineage committed atomically
  -> arXiv extraction eligible
```

Any validation, fetch, PDF, metadata, or persistence failure leaves the original capture
usable and reports an explicit failed promotion.

## Authoritative Extraction

| Field | Constraint |
|---|---|
| source kind | `arxiv_latex`, `true_ocr`, or `document_structure` |
| authoritative | True only for a complete accepted source-backed artifact |
| source artifact | Required for `arxiv_latex`; the downloaded source archive |
| markdown | Single Markdown reading copy; authored LaTeX remains authoritative |

Failed or partial provider output is quarantined or removed before the job is marked failed.
