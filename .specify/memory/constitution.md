<!--
Sync Impact Report
- Version change: 1.2.0 -> 1.2.1
- Modified principles: none
- Added sections: none
- Removed sections: none
- Governance clarification: the original ratification date is unavailable; the
  constitution records the first verified repository baseline separately.
- Follow-up TODOs: none
-->

# Math PDF Reader Constitution

## Core Principles

### I. Provenance Travels With the PDF
Every stored PDF MUST carry its source URL, capture time, and original SHA-256 inside
the PDF itself. The index and other derived records MAY accelerate lookup, but they
MUST NOT be the sole source of provenance.

### II. One Authoritative Extraction
Assistant answers MUST use the configured structured extraction as their paper text.
For arXiv papers, the LaTeX source itself is the authoritative artifact; any
Markdown conversion is only a convenience view. For papers without source, the
authoritative extraction MUST come from a true OCR or document-structure provider,
such as a configured Mistral OCR or MinerU Flash provider. Full-document output from
`pdftotext`, PyMuPDF, or equivalent PDF text libraries MUST NOT be authoritative.
When a sufficiently confident arXiv alternative is discovered for a paper captured
from elsewhere, the application MUST promote the arXiv version as the preferred
source and MUST make replacement or re-fetching from that source the primary recovery
action. The original captured file and its provenance MUST remain preserved as an
alternate record unless the user explicitly chooses otherwise.

### III. Reader Context Is Minimal and Explicit
Assistant page context MUST provide the exact page number reported by the reader, the
pointer to the authoritative extraction when one exists, and only a small naively
extracted PDF snippet as a search hint. The assistant MUST search and read the
authoritative extraction using its own tools; the application MUST NOT perform
approximate page-to-extraction mapping. The snippet MUST NOT be presented as source
text, used as a fallback, or used to replace the authoritative extraction. The exact
reader page number MUST still be supplied when the authoritative extraction has no
page data.

### IV. Fail Loudly
Missing, invalid, or low-confidence extraction MUST produce an explicit error. Runtime
paths MUST NOT silently fall back, default, return partial success, or convert
untrusted output into authoritative content. Generic PDF full-text output MUST NOT be
used to satisfy a missing extraction requirement; it MAY be used only as the bounded
page-search hint defined above.
Low-fidelity PDF text extraction MUST NOT be stored, selected, or described as a
structured extraction. A paper with only such output MUST remain extraction-unready
until a source-backed, OCR, or document-structure extraction succeeds.

### V. Tests Prove the Real Boundary
Behavior changes MUST be covered at the boundary where users observe them. Tests MUST
distinguish authoritative extraction from PDF text-layer hints and MUST fail if an
untrusted fallback is reintroduced.

## Architecture Constraints

The application owns wiring only. EmbedPDF renders PDFs; extraction plugins are
external commands described by JSON manifests; Zotero remains the citation store;
the bucket remains the reading store. Every PDF and reader page MUST remain reachable
through a stable local HTTP URL while the app runs.

## Development Workflow

Changes MUST preserve the constitution's source-of-truth and fail-loud rules. New
behavior requires a failing focused test before implementation, followed by the
smallest implementation that makes it pass and the applicable repository QC gates.
User-visible changes are not complete until the normal launcher has installed the
new app build and runtime behavior has been verified.

## Governance

This constitution governs repository architecture and supersedes convenience-driven
runtime behavior. Amendments MUST be made through Spec Kit, include a Sync Impact
Report, increment the semantic version, and preserve the rationale for each changed
principle. Reviews and implementation plans MUST check compliance with these
principles; unresolved violations block completion rather than becoming future work.

**Version**: 1.2.1 | **Ratified**: 2026-11-22 (original adoption date unavailable; first verified repository baseline) | **Last Amended**: 2026-11-22
