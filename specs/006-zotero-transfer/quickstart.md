# Quickstart: Deliberate Zotero Transfer Validation

## Tier 1 (no Zotero writes)

```bash
bun test tests/server-send.test.ts
bun test tests/server-capture.test.ts -t "citation tags"
```

Expected: each send against a closed Zotero port answers `zotero_unavailable` and keeps the
item unsent; refusals answer without contacting Zotero; reader pages carry `citation_title`,
`citation_author` and `citation_pdf_url`. Against the loopback write API
(`tests/zotero-stub.ts`), only a send writes to Zotero, a send files the item in the selected
collection, and each failed send keeps the local paper.

## Live suite (writes to the real Zotero library)

Run only with Zotero 8 and the local write API addon running, and with My Library (not a
collection) selected in Zotero's pane: the suite fails before any send otherwise. The suite
moves every item it creates to Zotero's trash.

```bash
just test-zotero-live
```

Expected: each paper becomes its own Zotero item with one "Full Text PDF". Send PDF Only
makes a standalone attachment with no parent. Send to Zotero and Extract stops at the first
plugin that succeeds and attaches `<ZoteroKey>_extracted.md`.

## Installed app (port 8770)

1. Capture a PDF, read it, file it and extract it. In Zotero, confirm no new item.
2. Select a collection in Zotero. Press **Send to Zotero** in the inspector. Confirm the item
   is in that collection with one PDF, and is gone from the bucket.
3. Quit Zotero and send another paper. Confirm the inspector's alert says "Zotero is not
   running: start Zotero" and the paper still opens.
4. Open `/read/<key>` in a browser with the Zotero Connector and save. Confirm the item takes
   the page's title and the PDF.
5. Move each test item to Zotero's trash.
