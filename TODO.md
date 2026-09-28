# TODO

## Ownership: Zotero owns bibliographic metadata

This app must not create or send BibTeX. Zotero owns how to get bibliographic information from a source.
The Zotero local write API probably already holds better heuristics for many kinds of sources than this app does.

Target: "Send to Zotero" passes the item's URL to the local write API and nothing else.
When Zotero must understand more kinds of URL, the write API absorbs that work, not this app.
The write API does not have that operation yet:
[zotero-local-write-api#31](https://github.com/dzackgarza/zotero-local-write-api/issues/31).
The roadmap's Decision Log records this decision (2026-09-28).

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

4. **Guess Metadata runs on the wrong rows.** At `src/web/Workspace.tsx:327`, the row menu's Guess Metadata uses the checked rows whenever two or more are checked, not the row you right-clicked.
   It writes guessed titles into those other PDFs and replaces manual metadata on them.

### Medium severity

5. **Capture misses some PDFs (breaks invariant 4).** `src/extension/interception.ts:107-113` misses these responses:

   - a `.pdf` URL served as `binary/octet-stream` (the S3 default) or `application/force-download`;

   - a `.pdf` URL with no `Content-Type`;

   - any PDF served as `application/x-pdf`.

   Chrome and Firefox also disagree on `application/pdf ;x`: Firefox intercepts it, Chrome does not.

6. **Any web page can make the Chrome extension capture a URL.** `capture.html` is open to every site (`wxt.config.ts:38`), and the background listener does not check that a message comes from the extension's own page (`background.ts:122`). A page that knows the extension ID can load that page in a hidden frame.
   The extension then fetches any URL with the user's cookies and stores it in the bucket.

7. **Re-stored PDFs keep an old source page.** `src/pdfbucket/provenance.py:51-74` does not write the source-page field when it is empty, so the value already in the file stays.
   Folder import and URL import give no source page.
   A PDF that came from another bucket keeps that bucket's source page, title and authors next to a new PDF URL and capture time.

8. **Chrome cannot open long PDF URLs natively.** `exemptions.ts:25,64` builds a regular expression from the whole URL. For signed S3 URLs and ScienceDirect URLs of about 150 characters or more, this pattern is too large for Chrome's regex limit.
   "Open in the browser" then fails.
   This result comes from the regex library alone with Chrome's limits; it was not reproduced in Chrome itself.

9. **Chrome can lose a capture silently.** The server answers a capture only after metadata lookup, which can take up to 60 s. Chrome can stop the extension's background worker after 30 s. The download marker is taken off before the post (`chrome-downloads.ts:142-152`), so no failure tab opens.
   This comes from reading the code; it was not reproduced.

10. **A timed-out extraction shows a schema error.** The server answers a timeout with 504 (`extractions.rs:260`), but the client accepts only 200, 422 and 502 (`useExtractionPlugins.ts:17`). The user sees a list of JSON schema errors in place of "timed out".

11. **Downloads have no size limit.** `imports.rs:365` and `sources.rs:61` read the whole response into memory.
    During Verify all or Rebuild all, several large downloads run at once and can exhaust the app's memory.

### Lower severity

| Bug | Location |
| --- | --- |
| Enter or Delete, pressed while a button or link has focus, opens or deletes the selected PDF instead of pressing that control | `useLibraryShortcuts.ts:26-44` |
| The library crashes when an item leaves while its row menu is open | `Workspace.tsx:316` |
| A backslash in a title breaks the BibTeX sent to Zotero | `send.rs:127` |

No defects were found in the Tauri shell, in the locking of index and filing writes, in atomic file writes, in key path checks, in XSS escaping, or in plugin subprocess handling.
