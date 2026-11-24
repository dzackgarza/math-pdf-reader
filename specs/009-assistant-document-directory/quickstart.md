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
- A new OpenCode chat opens in the document directory. A chat bound to the same
  paper moves there with its session ID intact. A legacy ID with no recorded
  provenance receives no page updates. Opening the paper creates a fresh chat.

## Provisioned validation

Run `just provision` and open the reader on port 8770.

## Acceptance scenarios

1. Open a PDF-only paper. Inspect the session location and confirm that the current
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

For URL import, run `bun test tests/server-import.test.ts -t 'Import URL stores'`.
Compare the embedded source URL and original digest with the publisher fixture and
open the returned key through its PDF and reader URLs.

In the live test the PDF-only scan has a readable catalog number and an obscured
signature. Check the answer and the reading limitation. Then check the answer against
both the Markdown passage and the accession in a separate metadata file.

Run `bun test tests/server-ai.test.ts -t 'failed text hint|damaged original'`.
A failed hint still delivers the recorded page to the chat. Missing and damaged
PDF failures produce distinct session errors.

## Replacement and enrichment in the installed reader

Use disposable papers with a known arXiv match and distinguishable passages. Start from the final provisioned revision on port 8770 with the configured assistant and an eligible extraction provider available.

1. Open the captured edition’s chat, record its session ID, and ask about a passage. Exercise a failed replacement download. Reopen the chat, verify the earlier exchange, and navigate to a different page. Check that the same session receives the displayed page.
2. Complete replacement. Navigate before opening a chat and check that the captured session receives no page update. Open the assistant at the same library address. Verify a new session ID, ask about an arXiv-only passage, and compare the answer with that edition. Navigate again and check both session transcripts for the destination of the page update.
3. Repeat selection of the same arXiv version. Verify that the session ID and the earlier arXiv answer persist.
4. With the chat open, run extraction from the app. After success ask for a passage unique to the published extraction without giving its path. Verify the answer, the file read and the unchanged session ID.
