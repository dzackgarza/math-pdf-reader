# Math PDF Reader Constitution

## Core Principles

### I. Provenance Travels With the PDF
Every stored PDF MUST carry its source URL, capture time, and original SHA-256 inside
the PDF itself. The index and other derived records MAY accelerate lookup, but they
MUST NOT be the sole source of provenance.

### II. Raw PDF Access and Authoritative Extractions
Assistant availability and answers MUST NOT require a structured extraction. The
assistant MUST be able to read bounded text from the stored raw PDF and answer from
that text when no authoritative extraction exists. An authoritative extraction MUST
supply additional context when one exists. For arXiv papers, the LaTeX source itself
is the authoritative artifact; any Markdown conversion is only a convenience view.
For papers without source, the authoritative extraction MUST come from a true OCR or
document-structure provider, such as a configured Mistral OCR or MinerU Flash
provider. Full-document output from `pdftotext`, PyMuPDF, or equivalent PDF text
libraries MUST NOT be presented as a structured extraction. When a sufficiently
confident arXiv alternative is discovered for a paper captured from elsewhere, the
application MUST promote the arXiv version as the preferred source and MUST make
replacement or re-fetching from that source the primary recovery action. The original
captured file and its provenance MUST remain preserved as an alternate record unless
the user explicitly chooses otherwise.

### III. Reader Context Is Minimal and Explicit
Assistant page context MUST provide the exact page number reported by the reader and
the address of that page's text in the stored raw PDF. It MUST also provide the pointer
to the authoritative extraction when one exists. The assistant MUST use the raw-page
address when it needs text from a particular PDF page and MUST search and read the
authoritative extraction using its own tools when one exists. The application MUST NOT
perform approximate page-to-extraction mapping. The exact reader page number and
raw-page address MUST still be supplied when no authoritative extraction exists.

### IV. Fail Loudly
A missing or invalid extraction MUST produce an explicit error when the caller
requests that extraction; it MUST NOT prevent assistant session creation or raw-PDF
answers. Runtime paths MUST NOT silently fall back, default, return partial success,
or convert untrusted output into authoritative content. Generic PDF full-text output
MUST NOT be used to satisfy an extraction request or be stored, selected, or described
as a structured extraction. Low-fidelity, bounded raw-page text serves the raw-PDF
reading path only. A structured extraction failure MUST leave that raw-PDF path
available.

### V. Tests Prove the Real Boundary
Behavior changes MUST be covered at the boundary where users observe them. Tests MUST
distinguish authoritative extraction from raw PDF text and MUST fail if an extraction
prerequisite is reintroduced. Raw-PDF tests MUST select a non-first page and prove that
only the requested page is returned. Assistant tests without an extraction MUST prove
an answer through the real raw-page HTTP boundary. A test MUST prove that an extraction
placed after a chat opens becomes available to that chat.

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
principle. Version increments use MAJOR for removed or redefined governance, MINOR for
added or materially expanded guidance, and PATCH for non-semantic clarification.
Reviews and implementation plans MUST check compliance with these principles;
unresolved violations block completion rather than becoming future work.

**Version**: 2.0.0 | **Ratified**: 2026-11-22 (original adoption date unavailable; first verified repository baseline) | **Last Amended**: 2026-11-24
