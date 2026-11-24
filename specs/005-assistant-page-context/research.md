# Research: Assistant Paper Sources and Page Context

## Raw paper access

**Decision**: Serve text from exactly one raw-PDF page at
`GET /api/ai/pdf-text/{key}?page=N` and tell the assistant to fetch that address.

**Rationale**: The configured model advertises text and image input and rejects PDF
attachments. PyMuPDF already provides page text through the store's Python boundary.
The bucket-only webfetch permission can reach the page route without shell access or a
new provider dependency.

**Alternatives considered**: Direct PDF attachment was tested and rejected by the
configured model. Other tested model routes were unavailable. Full-document raw text
was rejected because it is unbounded and would blur the distinction between raw paper
text and a structured extraction. Shell extraction was rejected because the reader
agent must not execute commands.

## Reader page context

**Decision**: Put the exact reported page, original PDF path and corresponding raw-page
address in the `reader-view` instruction entry. Do not enumerate extraction files or
infer extraction line ranges.

**Rationale**: Page identity comes from the reader. Page text comes from the same page
of the original PDF. Extraction discovery and navigation remain operations by the
assistant in the paper's document directory, not an approximate mapping or catalog owned
by the bucket.

**Alternatives considered**: Reintroducing `pdfbucket locate` would infer a line range
from text similarity and violate the explicit-context requirement. Supplying a raw
snippet without the page route would not let the assistant read beyond the snippet.

## Extraction after session creation

**Decision**: Place successful extraction output in the paper's document directory and
change no assistant instruction. New and existing sessions use that real directory. Do
not start OpenCode for a PDF whose assistant has never opened.

**Rationale**: Extraction can finish after the assistant starts. Generic directory tools
observe the new file on a later turn, so no catalog or source refresh is needed. The
backend is the common placement boundary for inspector and assistant-pane extraction
runs.

**Alternatives considered**: A synthetic workspace duplicates path authority and needs
refresh logic. Reopening the pane would make enrichment a session lifecycle operation.

## Verification

**Decision**: Prove non-first-page content at the real bucket HTTP boundary and use a
real-provider test that observes the raw-page request as well as the visible answer.
Place an unregistered artifact after chat creation and require a direct read in the
same chat. Prove extraction placement with the real fixture extractor.

**Rationale**: Page-1-only tests do not discriminate page selection, and an answer alone
does not prove which source supplied it. The new-artifact read proves discovery without
a source-specific instruction or endpoint.

**Alternatives considered**: A fake language model or extraction output written directly
into the root would bypass the behavior under test. Assertions about configuration alone
do not prove an answer path.
