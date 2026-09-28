# TODO

## Ownership: Zotero owns bibliographic metadata

This app must not create or send BibTeX. Zotero owns how to get bibliographic information from a source.
The Zotero local write API probably already holds better heuristics for many kinds of sources than this app does.

Target: "Send to Zotero" passes the item's URL to the local write API and nothing else.
When Zotero must understand more kinds of URL, the write API absorbs that work, not this app.
The roadmap's Decision Log records this decision (2026-09-28).

Tasks:

1. Expand the local write API so that it owns finding metadata for a relatively arbitrary source ([zotero-local-write-api#31](https://github.com/dzackgarza/zotero-local-write-api/issues/31)). It accepts an item as a URL and applies its own heuristics:

   - Zotero's web translators on the URL;

   - scraping of page metadata (`citation_*`, Dublin Core) and of the PDF itself;

   - discovery of a DOI, ISBN, arXiv ID or other identifier, then lookup by that identifier;

   - BibTeX that the source publishes, when it has some;

   - searches of other metadata services that the API knows about (Crossref, OpenAlex, zbMATH Open, MathSciNet, Open Library, arXiv).

2. Change "Send to Zotero" to call that operation with the item's URL.

3. Delete the resolver plugins, `manuscript_bibtex` and the BibTeX send path from this app.

Today the app does this work itself:

- The resolver plugins (`src/resolvers/*.ts`, `plugins/manifests/resolvers.json`) turn an identifier into BibTeX.

- `server/src/send.rs` sends that BibTeX through `import_bibtex`. Only arXiv goes through `import_by_identifier`. For an unidentified PDF, `manuscript_bibtex` writes a BibTeX entry by hand.

The write API's `openapi.yaml` (`~/gitclones/zotero-local-write-api`) lists these operations for metadata: `import_bibtex`, `import_by_identifier` (Zotero's identifier translators) and `run_javascript`. It lists no operation that runs Zotero's web translators on a URL.

This conflicts with the "Send to Zotero" row in `AGENTS.md` ("resolver plugins to BibTeX, then `import_bibtex`"). That row must change when the send path changes.

## Bugs found by code inspection (2026-09-28)

The inspection read the code only, not the GitHub issues.
The most serious findings were checked against the code; the rest were confirmed by reading the code or with small scratch scripts.

### High severity

1. **Send to Zotero can attach a PDF to a different paper's Zotero item.** `server/src/send.rs:237-239` looks for an existing Zotero item by URL. That URL is the source page, or the PDF URL when no source page is known (`send.rs:119`). Many PDFs share one source page:

   - Every PDF from a folder import gets the folder's `file://` URL (`imports.rs:236`).

   - Two arXiv papers captured from one listing page share that page.

   - Two papers from one journal contents page share that page.

   The first send writes the shared URL into its Zotero item.
   Every later send from the same page then matches that item.
   The later PDF, its notes and its Markdown attach to the first paper, and no item is made for the later paper.
   The bucket then marks the later item as sent, so it leaves the library.

2. **DNS rebinding gets past the origin guard.** `server/src/guard.rs:57` accepts any request marked `Sec-Fetch-Site: same-origin`, and no code checks that `Host` is `127.0.0.1` or `localhost`. A page whose domain name is switched to 127.0.0.1 counts as same-origin, so it can call every route:

   - read the library and every PDF;

   - delete items or send them to Zotero;

   - use `/capture-download` (`app.rs:154-172`), which reads any absolute path on disk into the bucket, and then read that file back.

3. **A new capture can take the key of a lost item and destroy its recovery record.** A key is a stored PDF's name in the bucket.
   `store.rs:316-320` treats a key as free when its PDF file does not exist, and it does not check the index export.
   Suppose an item's PDF has gone missing and a new PDF arrives with the same file name.
   The new PDF gets that key and takes the lost item's tags, notes, mirrors and Zotero record.
   The next export writes over the only record that `rebuild-cache` could use to get the lost PDF back.

### Medium severity

9. **Downloads have no size limit.** `imports.rs:365` and `sources.rs:61` read the whole response into memory.
   During Verify all or Rebuild all, several large downloads run at once and can exhaust the app's memory.

### Lower severity

| Bug | Location |
| --- | --- |
| A backslash in a title breaks the BibTeX sent to Zotero | `send.rs:127` |
| A thumbnail request for an item deleted while it waits for a render slot runs the renderer on a missing file and answers 500 with a traceback | `thumbnails.rs:35-56` |

No defects were found in the Tauri shell, in the locking of index and filing writes, in atomic file writes, in key path checks, in XSS escaping, or in plugin subprocess handling.
