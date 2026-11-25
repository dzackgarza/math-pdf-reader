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
