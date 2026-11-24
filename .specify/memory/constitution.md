<!-- Sync Impact Report: 4.0.0 to 5.0.0. Principle II now defines explicit
arXiv promotion as replacement of the current paper under its key. Feature 004
owns the promotion and recovery contract; Feature 009 owns the document directory. -->
# Math PDF Reader Constitution

## Core Principles

### I. Provenance Travels With the PDF
Every stored PDF MUST carry its source URL, capture time, and original SHA-256 inside
the PDF itself. The index and other derived records MAY accelerate lookup, but they
MUST NOT be the sole source of provenance.

### II. Paper sources and extraction

Every paper directory MUST contain its current PDF, including before enrichment and
after a failed extraction. The assistant can read that PDF without an extraction.
When the user explicitly promotes a confident arXiv match, the arXiv PDF MUST replace
the captured paper under the same key. The old PDF and its extraction leave the active
store after success. Preserve the captured provenance as historical lineage in the
replacement PDF. A failed promotion MUST leave the captured paper intact. Recover a
promoted paper from its arXiv source first. For arXiv enrichment, preserve the
authored LaTeX and convert its main document and included files into one readable
Markdown file. The assistant can read the Markdown and consult the LaTeX for details.
When usable arXiv source is unavailable, enrich the PDF with structured Markdown from
an eligible OCR or document-structure provider such as MinerU Flash or Mistral OCR.

### III. Paper directory and reader context

The app MUST open the assistant in the paper directory. The assistant chooses how to
discover and inspect files with its own tools, including shell commands. For example,
it can search a Markdown extraction and use `sed` to read the surrounding passage.
New files MUST be visible in the same conversation without registration or refresh.
For a question about the displayed page, supply the exact reader page number. The
app MAY add a short, labeled snippet from that page as a search hint. The assistant
locates the corresponding passage and checks it against a paper artifact itself.

### IV. Source fidelity and failures

Text-layer output from `pdftotext`, PyMuPDF and equivalent tools loses mathematical
layout and reading order. Its sole use for assistant context is the page-correlation
hint. Answers and quotations MUST be grounded in the PDF or a paper artifact. A
missing extraction MUST leave the PDF and session available. If the assistant cannot
read the available sources, it MUST report that limitation. Failed extractions MUST
report the failure and preserve the last complete result.

### V. Tests prove the real boundary

Acceptance tests MUST open a PDF-only paper, verify access to the original, and
exercise the reader's own tools in an enriched paper directory, including a real
shell read. Add a file after the chat opens and verify the same chat reads it.
Use a page whose text layer garbles a formula. Verify the displayed page number,
then require an answer supported by the passage in the paper artifact. A quotation
copied from the hint cannot establish source fidelity.

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

**Version**: 5.0.0 | **Ratified**: 2026-11-22 (original adoption date unavailable; first verified repository baseline) | **Last Amended**: 2026-11-24
