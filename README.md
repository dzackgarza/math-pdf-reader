# PDF Bucket

A standalone desktop app that replaces reading PDFs in the browser.
Browser extensions intercept PDF navigations in Chrome and Firefox and hand the PDF to the bucket, which stores it with embedded provenance, opens it in a PDF.js reader, and lets you file it, extract it, and send it to Zotero when it matters.

## Layout

| Path | What it is |
| --- | --- |
| `src/server` | Bun + Hono server: capture endpoint, PDF and reader URLs, library API |
| `src/web` | React library UI served by the server |
| `src/extension` | WXT WebExtension, built for Chrome and Firefox |
| `desktop/` | Tauri window that loads the server URL |
| `src/pdfbucket` | Python package: provenance embedding, PDF store, plugin manifest contract, extraction and resolver runners |
| `plugins/manifests` | Shipped extraction and resolver plugin manifests |
| `src/resolvers` | Resolver plugins: an identifier or URL on stdin, one BibTeX entry on stdout |
| `tests/` | Bun tests (`*.test.ts`) and Python tests (`test_*.py`) |
| `tests/fixtures` | Everything the tests and evidence scripts consume, including the Zotero Connector build (zip) |

## Data

Stored PDFs and the library index live in `$XDG_DATA_HOME/pdf-bucket` (`~/.local/share/pdf-bucket` when `XDG_DATA_HOME` is unset).

## Commands

```bash
just            # list recipes
just serve      # bucket server on the host and port in pdf-bucket.config.json
just run        # desktop window (starts the server first)
just build      # web bundle, both extension targets, desktop binary
just test-push  # full QC gate
```

Agents: read `AGENTS.md` first.
