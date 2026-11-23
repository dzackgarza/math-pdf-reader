# Data Model: Assistant Paper Sources and Page Context

## Stored Paper

- **Key**: The existing bucket item key; identifies the PDF in every assistant route.
- **PDF path**: `<root>/<key>.pdf`; the original stored paper with embedded provenance.
- **Reader page**: The first visible page reported by EmbedPDF; 1-based.
- **Reader page count**: The count reported by the reader for display context.

## Raw Page Text

- **Key**: Selects a stored paper.
- **Page**: Required 1-based page number.
- **Text**: The text layer of exactly that page, preceded by its page marker.
- **Validation**: The page must exist in the PDF. A missing page is an invalid request,
  not an empty success and not another page.

No raw-page response is saved as an extraction or included in the extraction index.

## Extraction Metadata

- **Source kind**: `document_structure`, `ocr` or `arxiv_latex` as declared by the
  plugin contract.
- **Authoritative**: Must be true for the assistant to receive the extraction pointer.
- **Text path**: `<key>.md` for document-structure and OCR extractions;
  `<key>.extraction/source.tex` for arXiv LaTeX.
- **Availability**: Missing metadata or a missing selected artifact means the extraction
  endpoint reports that no usable structured extraction exists.

## Assistant Session

- **Paper key**: One OpenCode chat per stored paper.
- **Workspace**: A paper-specific generated directory containing `AGENTS.md` and a link
  to the stored PDF.
- **Permissions**: No shell, edits or sub-agents; webfetch restricted to bucket paper
  routes; configured read permission for stored PDFs.
- **Source instructions**: Raw-page address always; authoritative-extraction address
  when available.
- **Reader-view entry**: Exact page, raw-page address and extraction search hint;
  refreshed on reader reports and extraction placement.

## State Transitions

1. **No extraction, no session**: Raw-PDF routes work; OpenCode is not started.
2. **Open session**: Create or reuse the chat and generate instructions from current
   extraction state. Extraction absence is valid.
3. **Reader changes page**: Update the existing chat's `reader-view` entry.
4. **Extraction succeeds**: Place the extraction, update the index, then refresh the
   workspace and `reader-view` only if that paper has an assistant workspace.
5. **Extraction requested but unavailable**: Return the extraction-specific error; keep
   raw-PDF routes and assistant sessions available.
