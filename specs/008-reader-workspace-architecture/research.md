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

## Window address in tab mode (FR-006)

**Decision**: while a reader tab is shown, the library window writes `/read/<key>#page=N`
with `history.replaceState`, and the library route while the Library is shown. This uses
the existing stable reader URL.

**Alternatives considered**: a hash route in the library window
(`#/read/<key>/page/N`) adds a second address for one reader page; limiting FR-006 to the
standalone page leaves FR-006 unmet in tab mode.
