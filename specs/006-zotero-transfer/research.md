# Research: Deliberate Zotero Transfer

## Selected collection for Send to Zotero (FR-005)

- **Decision**: Read Zotero's selected collection with the addon's `get_selected_collection`
  operation, then pass its key in `import_from_url`'s `collection_keys`. When the selected
  row is not a collection, use the library root. File an existing item that the import finds
  in the same collection.
- **Rationale**: The addon has both operations (addon repository `src/import-from-url.ts`
  `handleImportFromUrl`, `src/collections.ts` `handleGetSelectedCollection`). The AGENTS.md
  mockup table names Zotero's selected collection as the library target. `send.rs` sends
  neither field now, so the addon's `saveTarget` gets no collection IDs and the new item goes
  to the library root. Send PDF Only already lands in the selected collection
  (`placeStandalone` in the addon's `src/attach.ts`).
- **Alternatives considered**: A collection picker in the bucket. The spec names the citation
  store's own selection, and the mockup table puts no Zotero section in settings.
- **No collection selected**: Use the library root, as Send PDF Only does, and name that
  target in the send's answer (T031).

## Proof boundary for Zotero failures (US2, SC-003)

- **Decision**: Use a loopback stub of the write API, served by `Bun.serve` in the test and
  answering the addon's documented JSON, for failures after the import and for the
  implicit-write audit.
- **Rationale**: Tier-1 tests must not write to the user's library. The live suite
  (`tests/server-send-live.ts`) cannot make `/attach` fail after `import_from_url` succeeds.
  `tests/library-e2e.test.ts` already stubs `/version` and `resolve_url` this way with the
  recorded fixtures in `tests/fixtures/zotero/`.
- **Alternatives considered**: A closed port, as `tests/server-send.test.ts` uses. It shows
  only the health-check failure, which happens before any Zotero item exists.

## Markdown on a plain Send to Zotero

- **Finding**: Send to Zotero attaches existing extraction Markdown (`steps_owed`,
  `send.rs:74-88`). Send PDF Only refuses a paper with Markdown or notes (`send.rs:432-450`).
  So the user cannot send a paper that has an extraction to a Zotero item without its
  Markdown.
- **Status**: FR-003 does not forbid this. US1 says "with or without extraction output".
  It is intended: the roadmap Decision Log records the user's decision of 2026-10-07 that
  Send PDF Only refuses an item with notes or Markdown. No task changes this behaviour.
