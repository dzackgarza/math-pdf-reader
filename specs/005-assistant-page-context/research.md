# Assistant paper sources

The stored PDF retains the page layout and mathematical notation. LaTeX-derived or
OCR Markdown gives the assistant a searchable reading copy. Text-layer extraction
can scramble columns, lose symbols or omit equations. A short page snippet can help
find a passage, but the assistant must read the passage in the artifact.

Setting the session directory lets the assistant use its ordinary tools as the set
of files changes. A per-file HTTP interface would require the application to know
each artifact type and decide how the assistant should read it.
