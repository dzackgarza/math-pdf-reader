# Quickstart: Assistant Document Directory

## Automated focused checks

```bash
bun test tests/server-ai.test.ts tests/server-extractions.test.ts tests/server-document-directory.test.ts --timeout 30000
cargo check --package pdf-bucket
bun run typecheck
bun test ./tests/server-ai-live.ts --timeout 240000
```

The checks MUST establish:

- Capture writes `<root>/<key>/<key>.pdf` and successful extraction writes its Markdown
  and artifacts into the same directory.
- A flat store migrates with identical PDF bytes and embedded provenance. Partial
  migration resumes; destination collision fails loudly.
- Indexing, annotation saves, export, rebuild and deletion continue through the new
  paths without changing keys or item-relative artifact names.
- A new OpenCode chat is created in the document directory. An existing chat moves
  there without changing its session ID.

## Provisioned validation

Run `just provision` and open the reader on port 8770.

## Acceptance scenarios

1. Open a PDF-only paper. Inspect the session location and confirm that the original
   PDF is present and readable. If the configured tools cannot read its content,
   the assistant reports that limitation.
2. Open an enriched paper. Ask for a passage that requires searching the Markdown.
   Observe a shell command run from the paper directory and verify the answer
   against the passage read there.
3. Display a page whose text layer garbles a formula. Check the reported page number
   and the label on any snippet. Ask about the formula and compare the answer with
   the PDF or the structured extraction.
4. Place an unregistered artifact with unique contents in the directory after the
   chat opens. Verify that the same conversation reads it and returns those contents.
