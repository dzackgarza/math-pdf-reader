# Capture fixtures

The browser capture suite exercises the same eligibility policy in Chrome and Firefox.

| Fixture family | Expected result |
|---|---|
| `application/pdf`, `application/x-pdf` | Capture on GET document navigations |
| `.pdf` URL with generic or missing MIME | Capture |
| PDF `Content-Disposition` filename with generic or missing MIME | Capture |
| POST response | Leave native; do not re-fetch with GET |
| Small embedded frame | Leave native |
| Bucket-origin PDF | Leave native |
| Unavailable bucket | Show an explicit failure and native-open action |

`capture-cases.ts` is the shared response-predicate matrix. The browser end-to-end
suite additionally verifies request method, frame size, and origin boundaries.

`arxiv-corpus.json` contains titles, authors, and identifiers from the first 20
results of the arXiv API `cat:math.AG` query, retrieved 2026-11-22. The
discovery test serves these bibliographic records as a local Atom feed.

`image-only.pdf` is two pages of drawn shapes with no text and no outline, as a scan
without OCR is. Write it again with `uv run --with reportlab tests/fixtures/image-only.py`.
