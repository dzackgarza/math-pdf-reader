# Data Model: Reader Workspace Architecture

| Spec entity | Code today | Fields | Gap |
| --- | --- | --- | --- |
| Reader Manager | EmbedPDF DocumentManagerPlugin in the one `PDFViewer` (`src/web/reader/Reader.tsx`), with `newHost()` state (`src/web/reader/readerHost.ts`) | manager: `documentOrder`, `activeDocumentId`, per-document zoom and scroll; host: `held`, `bookmarks`, `focus`, `parked`, `moving` | none |
| Workspace Tab | `TabEntry` in `ReaderProjection {tabs, active}` | key, title, state (open, loading, failed, asleep) | built from manager plus host maps |
| Reading Record | `ReadingSchema` (`src/contract/library.ts`), written by `PUT /api/items/<key>/reading` | `unread`, or `viewed` with page, pages, zoom, viewedAt; zoom is absent from records written before the reader reported it | no record of open tabs |
| PDF Revision | the stored PDF; its SHA-256 ETag; `X-Pdf-Edition` | bytes, entity tag, provenance | none |
| Position (support) | `Position` (`src/web/reader/documentStorage.ts`) | pageNumber, x, y, zoom | lives only in memory |
| Bookmark (support) | `Bookmark` (`readerHost.ts`) | title, position, index | lives only in memory |

## State transitions of a PDF tab

```text
opening --load ok--> loading --openDocumentBuffer--> open(awake)
loading --load error--> failed --close--> (gone)
open --sleep / sixth awake tab--> asleep (bookmark; manager closed)
asleep --show--> loading --> open at bookmark position
open --close--> settle save --> (gone; reading record kept)
open --412 on save--> open + conflict --keep mine / discard--> open
```

## Validation rules

- A reading PUT names the edition it was read from; the server refuses a page beyond
  the page count (400) and an unknown key (404).
- A PDF PUT carries `If-Match` with the stored ETag; a stale tag gets 412 and no write;
  no tag gets 428.
