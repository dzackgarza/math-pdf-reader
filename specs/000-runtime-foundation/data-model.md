# Data Model: Runtime Foundation

## Reader Address

A stable local HTTP address for one stored paper.

| Field | Value | Owner |
| --- | --- | --- |
| origin | `http://<Host header>` of the request; the app binds `server.host:server.port` from `pdf-bucket.config.json` | `server/src/app.rs` `origin`, `server/src/lib.rs` `serve` |
| reader path | `/read/<percent-encoded key>` | `server/src/reader.rs` `reader_url_path` |
| PDF path | `/pdf/<percent-encoded key>.pdf` | `server/src/reader.rs` `pdf_url_path` |
| original PDF URL | `provenance.pdf_url`, embedded in the PDF | `src/contract/capture.ts` `ProvenanceSchema` |

Rules:

- The paths depend only on the key. A key that names no stored paper gives 404 at both
  paths, including an encoded path traversal.
- The capture response and the `open-reader` event carry `reader_url` and `pdf_url`
  on the local origin. They never carry the original URL in those fields.
- The reader page's `citation_pdf_url` is the local PDF address. The reader's Copy PDF
  link gives the original PDF URL.

## Application Runtime

The desktop process, its server and its window.

| Part | Owner |
| --- | --- |
| launcher and build freshness | `scripts/launch`, `scripts/source-fingerprint`, `scripts/provision.sh` |
| server | `pdf_bucket::serve` in `server/src/lib.rs`, called by `start()` in `desktop/src-tauri/src/lib.rs` |
| window | `WebviewWindowBuilder` in `desktop/src-tauri/src/lib.rs`, own page `desktop/src/index.html` |
| library and reader tabs | `src/web/tabs.tsx`, `src/web/reader/` |

### Launch states

| State | Condition | Result |
| --- | --- | --- |
| current | binary present, stamp equals fingerprint | start the installed binary |
| stale | stamp absent or different, or binary missing | run `just provision-for-launch`, then start |
| rebuild failed | the provision run exits non-zero | stderr message, critical notification, exit 1, no start |

### Window states

| State | Condition | Window shows |
| --- | --- | --- |
| serving | `start()` returns `Serving` | the library at the origin |
| start failed | `start()` returns a `StartFailure` | own page: "The bucket is not serving" and the report |
| stopped | the server task ends | own page with the stop reason |
| no own page | failure before the own page loaded | an error dialog |

`StartFailure` cases and the remedy each report must name:

| Case | Cause | Remedy in the report |
| --- | --- | --- |
| `Envrc` | `direnv export json` fails or prints bad JSON | the direnv output (for example `direnv allow`) |
| `Root` | the data root cannot be made | the path and the OS error |
| `NoWebBundle` | `<installed>/dist/web/index.html` is missing | `just provision` (the current text says `just build-web`; see T018 in tasks.md) |
| `Port` | the configured port exceeds 65535 | the configured value |
| `Bind` | bind or legacy-layout migration fails | the origin and the OS or migration error |
