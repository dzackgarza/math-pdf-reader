# Quickstart: Library Organization

## Run the focused API tests

```bash
bun test tests/library-api.test.ts -t "filing survives|collection's description|smart collection's rules|deleting a collection repairs"
```

## Run the focused UI tests

`tests/library-e2e.test.ts` shares one bucket across its tests, in file order. A filtered run
must include the tests that create the state a later test reads:

```bash
bun test tests/library-e2e.test.ts -t "row context menu adds a tag|reader records the last viewed page|rows chosen with their checkboxes|collection cards show counts|smart collection built from rules|each quick filter narrows"
```

## Check the installed app

1. Run `just provision`.
2. Open the library on port 8770.
3. Click each quick filter. Each shows only matching PDFs; a second click clears it.
4. Select a PDF. The inspector shows its source, mirrors and last check.
5. Open Collections, open a collection, set a description and Keep offline. The activity list
   records the change.

## How the library UI tests work

`tests/library-e2e.test.ts` proves the library window's workflows in the real UI. The app
serves the built web bundle over a temporary bucket of fixture PDFs, and Puppeteer drives it
in Chromium. Screenshots of each state go to `$TMPDIR/pdf-bucket-library-e2e`.

- **Bundle.** The setup runs `just build-web`, as `just provision` does. `bun test` sets
  `NODE_ENV=test`, so Vite bundles React's development build.
- **Fixtures.** The fixtures come in through the real capture endpoint. A local publisher
  serves each fixture path; a test can change what a path serves. The reading copy is the
  ten-page notes with a comment after their end: the pages are the same, but the bytes
  differ, so the store keeps it as a separate item. `outlined-notes.pdf` asks viewers to
  open its outline (`/PageMode /UseOutlines`).
- **Zotero.** The bucket gets a Zotero URL on a port where nothing listens, so a send fails
  and writes nothing. The send tests use the loopback Zotero stub instead.
- **A test past its time limit.** Bun stops the test and kills the processes that the file
  started ([zombie process killer](https://bun.com/docs/test/writing-tests#zombie-process-killer)).
  The bucket's server stops at once, and the browser stops later. Each test starts by
  asking the bucket for an answer; when none comes, the test starts a new bucket over the
  same store and a new browser. The cleanup after all tests also runs when a test or the
  setup fails, and closing the browser removes its profile.
- **Text waits.** `shows` reads the element's own text. `::-p-text` also matches a value
  typed into a field, so it would pass before the server has the change. For the same
  reason, the Verify test finds a mirror by its link in the sources list, not by its text.
- **Tests that add PDFs.** A test that captures, imports or opens its own PDFs deletes them
  at its end, so later tests see the fixtures as they were.
- **Proof that a filter or rule works.** Each quick filter must keep some items and drop
  others. A smart collection's two rule readings ("all" and "any") must give different
  lists, or the edit proves nothing.
- **Guess Metadata.** The browser answers each guess, so no model provider is reached; the
  test records which keys the library asked for. The action reports once every guess it
  asked for has answered.
- **Rebuild.** The index export is written after each change. The test waits until the
  export holds the item before it deletes that item's PDF.
- **Grid view.** The grid layout stays for the next visit; the list comes back only when
  the user chooses it.
- **Description.** An empty description clears the collection's description.
