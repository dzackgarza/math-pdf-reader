# Research: Reader Workspace Architecture

Source of the upstream facts: the installed `@embedpdf/*` 2.15.1 type declarations in
`node_modules/@embedpdf/core/dist/lib/store/initial-state.d.ts` and
`node_modules/@embedpdf/snippet/dist/components/app.d.ts`, and the EmbedPDF online docs.
The online docs describe a newer API (`layout.tabs`, Stage `getViewState`/
`applyViewState`, viewer-scoped shortcuts). The installed package has none of these.

Upstream facts at 2.15.1:

- `CoreState` holds `documents`, `documentOrder` and `activeDocumentId`. A document's
  status is `loading`, `loaded` or `error`. No `sleeping` status exists.
- DocumentManager: open, close, setActiveDocument, getActiveDocumentId,
  getDocumentOrder, moveDocument; events onActiveDocumentChanged, onDocumentOrderChanged,
  onDocumentClosed. No suspend.
- Per-document zoom and scroll live only while the document is open.
- `tabBar` is `always`, `multiple` or `never`. The built-in tab bar has no Library tab
  and no context menu.
- `history` config is annotation undo and redo. No navigation history.
- Commands KeyboardShortcuts listen for `keydown` on `document`.

Each decision below **needs the owner's decision**. The recommendation is not applied.

## D1: Where the active document lives (FR-003, SC-002)

- **A.** Derive the active tab from `getActiveDocumentId()`. Loading, failed and
  sleeping entries stay decorated overlays keyed by document id. A loading PDF is active
  only after the manager activates it.
- **B.** Keep `host.focus` as an app-owned active key that may name a PDF the manager
  does not hold yet.

**Recommendation**: A. FR-003 asks for manager state, not a parallel lifecycle. The cost
is a visible "loading" tab that is not yet the active manager document.

## D2: Navigation history (FR-002)

- **A.** Keep `Positions` and `host.moving` as now, documented as an app extension.
- **B.** Move them into a custom EmbedPDF plugin (`createPluginPackage`, `BasePlugin`)
  registered on the one viewer, so the manager's plugin registry owns navigation.
- **C.** Drop back and forward.

**Recommendation**: B. It keeps the feature and puts navigation under the manager, as
FR-002 says. C removes tested behaviour (`tests/library-e2e.test.ts:1110`, `:1178`,
`:1266`).

## D3: Sleep and wake (FR-005, FR-009)

- **A.** Keep the app bookmark (`Bookmark {title, position, index}`) and reopen on wake.
- **B.** Never sleep; keep every tab awake.
- **C.** Ask upstream for suspend, keep A until it ships.

**Recommendation**: C with A meanwhile. The spec allows sleep if state is restorable
(Assumptions), and test `:1413` proves the restore.

## D4: Window address in tab mode (FR-006)

- **A.** The library window writes `/read/<key>#page=N` with `history.replaceState`
  while a reader tab is shown, and the library route while the Library is shown.
- **B.** A hash route in the library window, for example `#/read/<key>/page/N`.
- **C.** Scope FR-006 to the standalone page; the tab offers the reader URL (copy link).

**Recommendation**: A. It uses the existing stable reader URL. C narrows FR-006, which
the spec does not allow without an edit.

## D5: The tab row

- **A.** Keep the custom Radix tab row, made a pure projection (see D1).
- **B.** Use EmbedPDF's built-in tab bar. It has no Library tab, sleep state or menu.

**Recommendation**: A.

## D6: Shortcut scope while the Library is shown

- **A.** Keep `scopeShortcuts`, which disables every shortcut category while the Library
  is shown.
- **B.** Ask upstream for element-scoped shortcuts; keep A until it ships.

**Recommendation**: B with A meanwhile. The spec has no requirement here; this is a
COMPLAINTS.md departure, recorded so the owner sees it.
