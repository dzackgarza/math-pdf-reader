# Data Model: Assistant Paper Sources and Page Context

## Stored Paper

- **Key**: The existing bucket item key; identifies the PDF in every assistant route.
- **Document directory**: `<root>/<key>/`; the paper's only current artifact directory.
- **PDF path**: `<root>/<key>/<key>.pdf`; the original stored paper with embedded
  provenance.
- **Markdown path**: `<root>/<key>/<key>.md` when a complete Markdown extraction exists.
- **Extraction artifacts**: `<root>/<key>/<key>.extraction/` when the plugin wrote
  artifacts. Other paper-specific files can occur anywhere beneath the document
  directory.
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
- **Authoritative**: Records the plugin's source contract. It does not control
  directory access or assistant availability.
- **Completeness**: The extraction directory moves first and the Markdown moves last.
  The Markdown's presence marks a complete extraction. Failed or running plugin output
  stays outside the paper's current record.

## Assistant Session

- **Session ID**: OpenCode's stable identifier for the paper's chat.
- **Location**: The stored paper's document directory for both new and moved sessions.
- **Reader-view instruction**: Original PDF path, exact reader page, raw-page address
  and an optional bounded raw-text search hint. An extraction adds no source-specific
  entry.
- **Discovery**: Generic read-only file and directory tools observe the current
  directory contents. A new artifact needs no session restart or source refresh.
