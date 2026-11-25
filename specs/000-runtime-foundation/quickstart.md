# Quickstart: Runtime Foundation Validation

## Prerequisites

- Bun, Rust, uv and the checkout's `.envrc` allowed with direnv.
- For the window test: Weston, `/usr/bin/WebKitWebDriver`, and user namespaces
  (`unshare -rn`).

## Automated checks

```bash
bun test tests/server-capture.test.ts -t "served at its PDF URL|name no stored PDF"
bun test tests/library-e2e.test.ts -t "reader link button copies the captured PDF URL|reader records the last viewed page"
just test-desktop        # release app through its window, including the failure cases
uv run pytest tests/test_launch.py   # launcher freshness and failed rebuild (T016, not yet written)
```

Expected: the reader and PDF addresses answer for a stored key and give 404 otherwise.
A revisit of `/read/<key>` shows the same paper at its recorded page. Copy PDF link
gives the original URL. The window reaches the origin and renders a captured PDF. It
shows the failure page when the port is taken or the web bundle is missing. A failed
rebuild exits 1 and never starts the installed binary.

## Installed checks (port 8770)

1. Run `just provision`, then start the app with `pdf-bucket`. The window shows the
   library and `curl -s http://127.0.0.1:8770/status` reports `"ready":true`.
2. Capture one fixture PDF with `curl -F pdf=@tests/fixtures/problem-set.pdf ...
   /capture-bytes`. The window opens it in a tab. Open the returned `reader_url` in a
   browser, reload it, and check that the same paper renders.
3. In the reader, press Copy PDF link and check that it gives the original URL, not
   the local address.
4. Make an uncommitted edit that breaks the build (for example a syntax error in
   `server/src/reader.rs`), then run `pdf-bucket`. The build terminal shows the error,
   a critical notification appears, and no window opens. Revert the edit.
5. With the app stopped, hold the port (`python -m http.server 8770 --bind 127.0.0.1`),
   then start the app. The window shows "The bucket is not serving" and names the
   origin and the OS error.
