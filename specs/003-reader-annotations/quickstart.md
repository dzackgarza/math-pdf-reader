# Quickstart: Reader Navigation and Annotations

## Focused tests

Build the web bundle first; the Puppeteer tests load the built reader.

```bash
bun run build
bun test tests/library-e2e.test.ts -t "back and forward walk"   # reader URL, exact page, reload
bun test tests/library-e2e.test.ts -t "outline entry or a search match"
bun test tests/library-e2e.test.ts -t "Ctrl+F puts the cursor"
bun test tests/library-e2e.test.ts -t "text note written on a page"
bun test tests/library-e2e.test.ts -t "right-click on selected text"
bun test tests/library-e2e.test.ts -t "failed annotation save"
bun test tests/server-capture.test.ts -t "read back into a reader page"  # citation tags
```

The desktop WebKitGTK tests run only as a set, through the release app:

```bash
just test-desktop
```

## Check in the provisioned app

After `just provision`, with the app on port 8770:

1. Open `http://127.0.0.1:8770/read/<key>#page=3`. Page 3 shows. Scroll to page 5; the address
   reads `#page=5`. Reload; page 5 shows.
2. Open `#page=9999`. A message names the page as outside the PDF, and page 1 shows.
3. Ctrl+F, type a word, press Enter; the next match shows. Open the outline and press an entry.
4. Select text, right-click, press Highlight. Write a note with the text tool. Close and reopen
   the PDF; both are there. Edit the note's text, delete the highlight, reopen; the change holds.
5. Select the highlight tool in Annotate mode; no options popup stays over the page.
6. Open a PDF from the library and press PageDown before any click; the PDF scrolls.
