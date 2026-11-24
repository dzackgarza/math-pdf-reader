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
- Permissions permit generic read/list/glob/grep discovery and no source-specific
  extraction file needs a permission or prompt update.
- Missing extraction still permits a non-first raw-page answer through the real
  provider.
- A real provider answer uses an unregistered artifact placed in the document
  directory after the chat opened.

## Provisioned app verification

```bash
just provision
```

Against `http://127.0.0.1:8770`:

1. Confirm the existing flat user store has migrated. Each inspected item has its PDF
   and prior extraction under `$XDG_DATA_HOME/pdf-bucket/<key>/`; old current paths
   are absent and library counts/keys remain.
2. Open the no-extraction item `0002066v1`. Ask for the page-2 sentence beginning
   `E =`. The answer must use the raw original PDF and identify the Eisenstein-integers
   definition without requiring extraction.
3. For an enriched item, add a unique plain-text artifact directly to its document
   directory without restarting the chat. Ask for the unique phrase. The same chat
   must discover and answer from the new artifact.
4. Confirm `$XDG_DATA_HOME/pdf-bucket-ai/workspaces` is not used for current source
   discovery and no paper `AGENTS.md` catalog was created.
