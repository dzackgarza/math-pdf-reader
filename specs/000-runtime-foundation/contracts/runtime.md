# Runtime Contract

## Launcher

`~/.local/bin/pdf-bucket`, the launcher entry and the autostart entry all run
`scripts/launch`.

| Input | Behaviour |
| --- | --- |
| stamp equals `scripts/source-fingerprint`, binary present | `exec ~/.local/bin/pdf-bucket-desktop "$@"` |
| stamp absent or different, or binary missing | notify "Source changed: rebuilding before launch"; run `just provision-for-launch` in a kitty window; on success start the binary |
| rebuild exits non-zero | the kitty window keeps the output until Enter; stderr gets `pdf-bucket: rebuild failed; see the Math PDF Reader build terminal for details`; critical notification with the same text; exit 1; the binary does not start |
| kitty missing | stderr and critical notification `kitty is required to show the rebuild output`; exit 1 |

## Window

The window opens on the bundled page `desktop/src/index.html`, then goes to the bucket
origin or to that page with a report.

| Condition | Window URL | Visible text |
| --- | --- | --- |
| serving | `http://127.0.0.1:8770/` | the library |
| start failed or server stopped | own page, report percent-encoded in the fragment | heading "Math PDF Reader is not serving" and the report |

## Addresses

| Method and path | Answer |
| --- | --- |
| `GET /read/<key>` | 200 HTML reader page with `citation_title`, `citation_author`, and `citation_pdf_url` = `<origin>/pdf/<key>.pdf`; 404 for an unknown key |
| `GET /pdf/<key>.pdf` | 200 `application/pdf`, the stored bytes, `ETag` = SHA-256, `x-pdf-edition`, range support; 404 for an unknown key |
| `POST /capture-bytes` | `reader_url` and `pdf_url` on the local origin; the original URL only in `provenance.pdf_url` |
| `GET /api/events` `open-reader` | `{ reader_url, title }`; the library opens the key's reader in a tab |
