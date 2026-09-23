# PDF Bucket

A standalone desktop app that replaces reading PDFs in the browser.
Browser extensions intercept PDF navigations in Chrome and Firefox and hand the PDF to the bucket, which stores it with embedded provenance, opens it in a PDF.js reader, and lets you file it, extract it, and send it to Zotero when it matters.

## Layout

| Path | What it is |
| --- | --- |
| `apps/server` | Bun + Hono server: capture endpoint, PDF and reader URLs, library API |
| `apps/web` | React library UI served by the server |
| `apps/extension` | WXT WebExtension, built for Chrome and Firefox |
| `apps/desktop` | Tauri window that loads the server URL |
| `src/pdfbucket_plugins` | Python package: plugin manifest contract and command wrappers |
| `plugins/manifests` | Shipped extraction and resolver plugin manifests |
| `tests/` | Python tests; TypeScript tests live beside each app |

## Commands

```bash
just            # list recipes
just serve      # bucket server on 127.0.0.1:8765
just run        # desktop window (starts the server first)
just build      # web bundle, both extension targets, desktop binary
just test-push  # full QC gate
```

Agents: read `AGENTS.md` first.
