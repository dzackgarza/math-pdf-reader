# Audit: math-pdf-reader

I read all the source code for the server, desktop, web UI, extension, contracts, resolvers, and the Python store and plugins.
I confirmed each finding in the code at the cited line.
"Reproduced" means I also ran it against a temporary data root.

## 1. Paths that lose user data

| # | Defect | Where | Evidence |
| --- | --- | --- | --- |
| 1 | **Two captures of the same filename at the same time lose one PDF, and both report success.** `destination()` checks that the key is free, then both processes write the same `<key>.partial` and rename it into place. Nothing serializes writes to one key, and `replace`, `embed_metadata`, `restore` and thumbnails share the same fixed `.partial` name. Trigger: several `download.pdf` or `fulltext.pdf` links opened at once. | `src/pdfbucket/store.py:64-86`, `server/src/app.rs:49` | reproduced |
| 2 | **A reader save made from stale bytes is accepted.** `replace_pdf` checks only that the provenance fields match, and every older version of the file passes that check. Retrieve metadata followed by an annotation reverts the title, authors and year. With two views of one PDF open, the last save wins and the other view's annotations are lost. | `store.py:140-153`, `library.rs:182-205` | reproduced |
| 3 | **One failed save stops all later saves in that reader tab.** `saves = saves.then(save)` has no rejection branch. A fetch error, or any `AppError::Internal` (plain-text body, so `.json()` throws), leaves the chain rejected. A refused save still resolves, so the tab closes and the annotations are gone. A store failure shows "Not saved: undefined". | `server/templates/reader.html:235-256`, `tabs.tsx:114` | read |
| 4 | **The backup export can stop updating permanently, and the only sign is a line on stderr.** If one PDF is missing, `export_index` refuses to write. No route can forget the missing item: DELETE gives 404 because `require()` needs the PDF. The `removed` set is held in memory only, so a quit between trashing a PDF and the next export freezes the export after restart. | `export.rs:41-56, 233`, `send.rs:283` | reproduced |
| 5 | **Send to Zotero deletes the item's notes, tags, collections and mirrors, and can trash the annotated PDF.** After a send, the item is removed unless it is kept offline. Notes are never sent. If Zotero's import already has a file that hashes to `original_sha256`, the bucket's annotated copy is never attached. That copy then goes to the trash, and the export forgets the item. | `send.rs:185-222` | read |
| 6 | **A new extraction permanently deletes the previous one**, including paid MinerU Precise output. The old `<key>.extraction/` moves into the temporary staging directory, and the staging directory is then deleted. Item removal uses the trash, so the two paths behave differently. | `extraction.py:111-116` | read |
| 7 | **A filename of `..pdf` breaks the whole library.** `key_stem` returns `"."`, `store_pdf` never checks the key, and after that every `list` call fails. The rule for a valid key exists in three places that disagree (`key_stem`, `is_plain_key`, `store.rs:52-59`). The filename comes from the website. | `store.py:35-47` | reproduced |
| 8 | **Tag, collection and preference edits send the whole array, built from the client's copy.** Two quick edits, or two open windows, undo each other. The library never refreshes on its own, and responses are applied in the order they arrive, so the stale copy is the normal case. Bulk actions already use add/remove requests; single-item edits do not. | `InspectorPanel.tsx:203-235`, `libraryActions.ts:59,188`, `useLibraryApi.ts:81-87` | read |
| 9 | **Typed input is lost.** A note is deleted with one click and no confirmation. The note draft, the NameDialog fields and the smart-collection rules are cleared before the server accepts them. The note draft is also lost on a tab switch or a new selection. | `InspectorPanel.tsx:292,303`, `NameDialog.tsx:37`, `SmartCollectionDialog.tsx:186` | read |
| 10 | **Unsaved annotations are discarded in three more ways:** a render error in the library UI removes every reader iframe, because `ErrorBoundary` wraps `ReaderTabs`; Quit from the tray exits inside the 700 ms save delay; and `import-index` refuses to run once the app, starting at login, has written a new empty `organization.json`. The export also leaves out the reading sessions and all extraction output. | `main.tsx:37-43`, `desktop/src-tauri/src/lib.rs:230`, `export.rs:92-100` | read |

## 2. Failures reported wrongly (invariant 5 and related)

- **The capture page can stay on "Saving…" with no error and no link to open the PDF natively.** `void handle(...).then(sendResponse)` has no rejection branch (`background.ts:56`). Four things can throw there:

  - `decodeURIComponent` on a Latin-1 escape such as `caf%E9.pdf` (reproduced);

  - `blob()` outside `settle()`;

  - the contract parse of the server's answer;

  - `LinkOriginsSchema.parse` of stored records.
    After any extension update that changes the record fields, this breaks every capture.

- **Capture answers 500 after the PDF is already stored.** `retrieve_metadata(...)?` runs after `store.capture` (`app.rs:49-70`). The export and the open-reader event are then skipped.
  Folder import (`app.rs:252`) and batch rebuild (`try_join_all`) have the same problem: one error discards the outcomes of work already finished.

- **Error responses come in 4–6 shapes, and the zod contract covers only one.** `store_command_failed` exists only in the web client, and Internal errors are plain text (`error.rs:69-100`). Clients guess the shape, and defect 3 above comes from this.

- **A Python store that exits early loses its stderr.** stdin is written before the output is read, so the write fails with EPIPE (`store.rs:91-95`). Every Python exception reaches Rust as exit code 1 plus text, so Rust cannot tell the failures apart.

- **The export refusal and the desktop's `.expect()` calls at run time** (`lib.rs:171,191,228`) fail silently or bring down the server, because the server runs in the same process as the window.

## 3. Architecture and boundaries

- **The contract is not a single source of truth.**

  - typify drops `.trim()`, `.refine()` and numeric `minimum`, and Rust copies these checks by hand (`library.rs:31,209,418`, `config.rs:135`).

  - The pydantic models are a third, looser hand copy (`models.py`, `manifest.py`), with plain `str` where zod requires a sha256 or a non-empty string.

  - `AnyUrl` rewrites the provenance URLs stored in the PDF (host case, `%20`, punycode).
    This breaks the exactness that invariant 1 requires.

- **The store's file layout is known on both sides.** `store.rs` says Python owns the layout, but Rust reads `<key>.pdf`, `.md` and `.extraction` itself.
  The `%PDF-` check exists 4 times, and the key check 3 times.

- **The live app runs the checkout's working tree.** Every store call is `uv run --project <checkout>` (`config.rs:63`). Switching branches changes how the installed app writes your data.

- **The export and the index do not share one reader.** The export starts a pikepdf scan of every PDF after every filing write, including each page-turn report.
  `LibraryIndex` has a cache, but the export does not use it.

- **No timeouts:** store subprocess, extractors and `reqwest` client.
  `send` holds `state.sends` through the resolver and Zotero calls, so one stalled send blocks every delete.
  MinerU's `@retry` resubmits a batch that is still running as a new paid job.

- **Checks run outside the write lock.** `require()` and `collection_ids()` run before `change()`, and `or_insert_with(unfiled)` then creates filing for a key that was deleted in the meantime.
  A later capture with the same key inherits that filing, including a stale Zotero record.

## 4. Fallbacks, guessing the data type at runtime, and runtime error handling

| Site | Pattern |
| --- | --- |
| `capture.ts:58` | A failed link-origin lookup silently records `source_url = pdf_url`. The lookup always misses for DOI or redirect links and URLs with fragments. It can also match a click from any earlier date. |
| `useLibraryApi.ts:106` | `safeParse` guesses whether a response is the whole library, although each call site already knows its schema. |
| `librarySelectors.ts:29-37` | A deleted collection view silently falls back to All Items. Elsewhere in the same file, the same condition throws. |
| `smartRules.ts:31-37` | `?? ""` defaults. On an empty library, `new URL("")` throws. |
| `SmartCollectionDialog.tsx:140,159,206,238` | Unknown select values are coerced to a default. `typeof rule.value` is used instead of a switch on `rule.field`. |
| `format.ts:68`, `InspectorPanel.tsx:225` | `names.get(id) ?? id` hides references to collections that no longer exist. |
| `send.rs:95-150` | `Option<AppError>` wraps the result, and then a wildcard `_ =>` match catches a variant that cannot reach it. |
| `imports.rs:216`, `imports.rs:28` | Folder import skips non-`%PDF-` files and does not report them. An empty URL path becomes `download.pdf`. |
| `exemptions.ts:36` | The rule id is `max+1` without a lock, so two small frames at once collide (Chrome only). |
| `reader.html:195`, `tabs.tsx:114` | Checks for PDF.js private fields (`_maxUid`) and `settleReader?.()` calls stand in for an explicit model of the frame's load state. |

## 5. Minor bugs

- The popup names `systemctl --user start pdf-bucket`, but no such unit exists (`popup/main.ts:62`).

- A collection description cannot be cleared (`NameDialog.tsx:77`).

- Two fetches skip the `response.ok` check (`useBucketStatus.ts:24`, `TimelineScreen.tsx:45`).

- When `/status` fails, the Settings screen is blank (`SettingsScreen.tsx:34`).

- Deleting a collection leaves saved searches that point to it (`organization.rs:289`).

- Duplicate detection uses only the filename, so the same bytes under two URLs become two items.

- A Mistral upload is not deleted when OCR fails.

- The server has no CORS or Content-Type check.
  Any web page can therefore POST `/api/items/{key}/zotero`, which sends the item and then removes it.

## Fixes that need your decision

Three root causes need a design decision.
Most of the other defects follow from them.

1. **Store writes:** add a per-key lock in the Rust server around every store call.
   The other choice is to move the store's write paths into Rust and keep Python only for the pikepdf work.
   This decision resolves defects 1 and 7, part of 2, and the checks outside the lock.

2. **Reader save protocol:** the PUT names the sha256 of the file the reader loaded, and the server answers 409 when the file has changed since then.
   The reader then reloads and shows the conflict.

3. **Send semantics:** decide whether notes and the annotated PDF go to Zotero (as child notes and the attached file), or whether the send stops removing the item's filing.

The other items have obvious fixes.
Examples: a rejection branch in the reader save chain and in the background `sendResponse`; the trash for old extractions; one error envelope in `src/contract`; the export refusal shown in the status bar with a route to forget a missing item; delta writes for tags and collections.

## Appendix: findings not in the summary above

### Extension, contract, resolvers

- `link-origin.ts`: the last 50 link records are kept with no age limit, so a PDF URL typed in today can match a click on another page from last week.

- `capture/main.ts:36-39`: `openNatively` waits for the `exempt` reply.
  If the reply never comes, the native open does not happen and the page shows no error.

- `capture.ts:45`: capture discards the browser's own response and fetches the PDF again.

  - A signed or single-use URL answers 403 on the second request.
    "Open in the browser" then fails too.

  - In Firefox the background `fetch` uses the default container's cookies, not the cookies of the tab's container.

  - The refetched bytes are never checked for `%PDF` or a PDF content type.
    A login-page HTML answer is posted as `application/pdf`, and only the server refuses it.

- `bucket-status.ts:48`: `response.json()` runs on any 2xx answer without a content-type check.
  If another service on port 8770 answers with HTML, `checkBucket` throws, `refresh()` drops the error, and the badge keeps its old "ON". The comment at `:27` says this case is unreachable; the code does not make it so.

- `src/resolvers/arxiv.ts:12-33`: BibTeX fields are renamed with regex (`biblatexEprintFields`), and the abstract is added with hand-written brace balancing (`withAbstract`). `@citation-js/plugin-bibtex` is already a dependency and is used in `contract.ts:68`.

- `src/resolvers/contract.ts:72-76` (`writeBibtex`): the only check is `startsWith("@")`. The contract says exactly one BibTeX entry, but two entries or a broken entry pass the check.

- `zbmath.ts:58-60` (`optionalText`): a blank upstream field becomes an absent field.

- `plugins/manifests/*.json` are validated by two independent schemas (zod and pydantic).

### Web UI

- `App.tsx:197`, `libraryActions.ts:478-482`: Delete and Send to Zotero leave that item's reader tab open.
  Closing the tab calls `settleReader` for a key that no longer exists.

- `useLibraryApi.ts:106` with `App.tsx:284`: if the re-fetch after a successful mutation fails, the state becomes `failed` and `Workspace` unmounts.
  Search, selection, dialogs and in-flight send and extraction status are lost.
  "Reload Library" unmounts `Workspace` in the same way.

- `useLibraryApi.ts:18-22,40`: `requestError` tells the two error formats apart with `failure.error !== "store_command_failed"`. A non-JSON error body throws `SyntaxError` and loses the HTTP status.

- `SmartCollectionDialog.tsx:221-226,238-245`: an unknown field, or an operator change that fails `RuleSchema.safeParse`, is silently dropped.

- `App.tsx:74`: the list/grid layout value is coerced to a default in the same way.

- `App.tsx:244-248` vs `App.tsx:188-194`: `rowMenu` returns `null` for an item that is not found, and `openReader` throws for the same condition.

- `App.tsx:109-497`: `Workspace` is one component of about 390 lines with 12 pieces of state.
  It rebuilds the action context on every render, and its keydown effect has no dependency list (`:208-242`), so the listener is registered again on every render.

- `commands.ts:33-48`: `reader` and `send` repeat the `onSelected` helper defined at `:46`.

- "Rebuild all" starts N concurrent mutations plus N refreshes.

### Server routes and Zotero

- `send.rs:250-255`: the Zotero record is saved only after `import_by_identifier` or `import_bibtex` returns.
  If the client disconnects during the import, axum drops the handler future.
  Zotero still creates the item, the bucket never records its key, and the next send creates a second Zotero item.
  `ZoteroWriteApi` has no idempotency check (for example a lookup by URL or DOI).

- `zotero.rs:124,130`: a non-JSON error body from Zotero (for example a 404 when the write-API addon is not installed) becomes a generic Internal 500, not `zotero_failed`.

- `zotero.rs:151-179`: `pdf_with_hash` never checks the HTTP status.
  An error status becomes either "Zotero did not answer" or a URL-parse Internal error.

- `send.rs:151`: a manuscript send builds its BibTeX from `provenance.title_hint`, the capture-time hint, not from `stored.title`, which the library shows.

- `app.rs:252-259`: folder import resolves each file over the network in sequence inside one HTTP request, with no timeout.

- `source_routes.rs:298-344`: two rebuilds of the same key at once fail the `assert not path.exists()` in `restore_pdf`. Through `try_join_all`, that one failure discards every outcome already finished.

- `source_routes.rs`, `rebuild_one`: each key reads the whole index and the export again, so a batch of N keys costs N full index reads.

- `sources.rs:140-150`: restore followed by `record_metadata` is not atomic.
  A metadata failure reports the rebuild as failed although the PDF was restored.

- `reader.html:261`: `ownCallback?.()` is an optional call on a PDF.js callback.

### Server persistence

- `store.py:40`, `thumbnails.rs:24-27`: `sanitize_filename` limits the stem to 255 bytes.
  Adding `.pdf`, `.partial` or `--<hash>` goes past the filesystem limit (ENAMETOOLONG), and the capture fails.
  Thumbnail cache names percent-encode the key, which can make a non-ASCII name up to 3 times longer.

- `imports.rs:16` (`is_pdf`): requires `%PDF-` at byte 0, but the PDF format allows the header anywhere in the first 1024 bytes.
  Add Folder also loads every file in the folder into memory before it stores the first one.

- `organization.rs`: `update_collection` and `replace_saved_search` do nothing for an unknown id and depend on the checks done outside the lock.

- `export.rs:106-107`: `import_index` finds "never filed" items by comparing `serde_json::Value`s.

- `write_json`: one fixed `<file>.partial` name, so `just export-index` run while the app runs means two processes write the same partial file.
  No fsync.

- `config.rs:109-111`, `state.rs:71-88,102-112`: `index_export: Option<PathBuf>` exists only for tests.
  Production always has `Some`. `None` silently turns off the export and empties the Missing list, and tests that run without an export do not exercise the export paths.

- `index.rs:142-161`: a foreign or torn PDF in the root raises `MissingProvenanceError` in `list`. `GET /api/library`, every `require()` and the export then fail, and nothing tells the user which file caused it.

- `index.rs:182-188`: every `require()` reads the whole index and walks every extraction folder.

### Python store and plugins

- `mineru_precise.py:139-151,160-176`: when one chunk fails, the results of every finished chunk are discarded.

- `thumbnails.py:19-21` (with `THUMBNAIL_RENDERS = 2`): two requests for the same key and width while the thumbnail is stale both write the same `.partial` file.
  The second `replace` raises `FileNotFoundError`, which becomes an HTTP 500.

- `resolution.py:102`, `extraction.py:136`: no timeout on resolver or extractor subprocesses.
  A hung `bunx mineru-open-api` holds the HTTP request open forever.

- `models.py:33`: `original_sha256: str` has no hex or length constraint.
  A malformed hash in an export reaches `restore` and comes back as `ChangedPdfError`, not as a validation failure.

- Pydantic vs zod differences: `stored_sha256` and artifact `sha256` (`Sha256Schema` vs `str`); `key`, `authors[]` and `abstract` (`NonEmpty` vs `str`); `trashed` (`.min(1)` vs `list[str]`, repeated by hand in `store.rs:199`).

- `extraction.py:92-93`: extraction and resolver manifests share one `PluginManifest` type, so `extract` finds a wrong manifest kind only through `assert inputs`.

- `provenance.py:92-100`: `[str(name) for name in json.loads(...)]` on `/PDFBucketAuthors`, instead of validating it as `list[str]`. `provenance.py:46-48` calls `str(value)` on values that are already strings.

- `scripts/connector_save.py:190`: `mkdtemp` creates a Chromium profile that is never cleaned up.

- `scripts/library_screenshots.py:380-381`: Weston's stderr goes to `DEVNULL`.
