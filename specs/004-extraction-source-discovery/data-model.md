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
| confidence | Number in `[0, 1]`; ranks the candidates; the user chooses which one to promote |
| reasons | Non-empty explanation of the score |

## Source Lineage

Historical provenance of a captured paper whose PDF the user replaced with an arXiv PDF.

| Field | Constraint |
|---|---|
| original item key | Required; the paper keeps this key after replacement |
| preferred item key | Required; equals the original item key after replacement |
| discovered source URL | Required arXiv URL |
| promoted at | Required timestamp |
| original provenance | Historical captured URL, time, and hash embedded in the current arXiv PDF |

The one current item exposes this lineage. Its PDF has arXiv provenance and may
expose the old capture URL as historical context. The captured PDF and its prior
extraction leave the active store on success. Filing and reading state stay with
the key. Lineage is committed with the replacement PDF, and a repeated request
for its arXiv identifier/version returns the same item.

## State Transitions

```text
captured non-arXiv item
  -> discovery candidates
  -> candidate chosen by the user
  -> promotion requested
  -> source fetched and verified as PDF
  -> arXiv PDF and lineage replace the current paper at the same key
  -> arXiv extraction eligible
```

Any validation, fetch, PDF, metadata, or persistence failure leaves the captured
paper and its extraction usable and reports an explicit failed promotion.

## Authoritative Extraction

| Field | Constraint |
|---|---|
| source kind | `arxiv_latex`, `true_ocr`, or `document_structure` |
| authoritative | True only for a complete accepted source-backed artifact |
| source artifact | Required for `arxiv_latex`; the downloaded source archive |
| markdown | Single Markdown reading copy; authored LaTeX remains authoritative |

Failed or partial provider output is quarantined or removed before the job is marked failed.
