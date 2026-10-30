Nothing hand-rolled draws the highlight. What is hand-rolled is everything around highlight persistence — the repo took over the job PDF.js expects to do itself.
PDF.js's own model: you edit, it marks the document modified, and it saves by handing you a download. This repo replaced that whole half:
Hand-rolled
storage.onSetModified monkeypatch + 700 ms debounce + serialized save chain
beforeunload → stopImmediatePropagation
Own viewer.open() lifecycle, user-copy, conflict bar
isViewerEmbedded = false on a framed viewer
forcePageColors + hand-picked #2E3440/#D8DEE9
Own address-fragment + uid history bookkeeping
ETag conditional replace, then pikepdf re-save of the bytes
So: rendering is upstream, persistence is bespoke. The bespoke part owns the dirty flag, the byte stream, and the final serialization — which is precisely the surface a "blob covers the text" bug can live on, whether the cause is the re-serialized appearance stream or the editor's quads after a document swap. Either way it is code this repo wrote, not code PDF.js shipped.
That is also the invariant-7 question worth settling: AGENTS.md claims "no hand-rolled PDF viewer" on the strength that PDF.js renders. The truth is narrower — PDF.js renders, and the bucket hand-rolls the document lifecycle around it.

More complaints:

You have to click on a PDF before keyboard shortcuts are recognized

The highlighting interface is incoherent. You can't select + right-click to highlight, clicking the highlighter tool opens options instead of selecting the tool

Actually, more: clicking the highlighter tool DOES select the tool, but it leaves the tool option popup open..

**The architectural problem is that the app embeds a complete reader, then builds another reader controller around it.** The “wiring only” boundary does not hold for navigation and document lifecycle.

The concrete departures are:

- **Independent viewer instances behind custom tabs.** [tabs.tsx](/home/dzack/gitclones/math-pdf-reader/src/web/tabs.tsx:386) mounts a reader per awake tab and hides inactive readers with CSS. EmbedPDF already provides document management and active-document switching. Its own tab bar is disabled here. [Upstream API](https://www.embedpdf.com/docs/react/viewer/plugins/plugin-document-manager)
- **Custom unloading and reconstruction.** The app destroys sleeping readers, saves `{page, zoom}`, then reconstructs their position. That representation loses the position within a page. This makes view continuity the app’s responsibility.
- **Custom navigation history.** [Reader.tsx](/home/dzack/gitclones/math-pdf-reader/src/web/reader/Reader.tsx:270) maintains its own `Positions` stack. A mutable `walking` flag distinguishes its navigation from other navigation, using asynchronous viewer events.
- **Manual input coordination.** Because those separate viewers register document-wide shortcuts, [scopeShortcuts](/home/dzack/gitclones/math-pdf-reader/src/web/reader/Reader.tsx:529) manually disables command categories in hidden readers.

These decisions introduce app-owned state that must remain synchronized with the viewer’s state: which document is active, which position is authoritative, whether navigation is underway, and which reader receives input. **Those synchronization obligations are the additional failure class introduced by this architecture.** Importing EmbedPDF does not remove them.

The architectural direction is to let its document manager own document activation and lifecycle, with the bucket supplying storage and library actions. Any required reader behavior missing upstream needs an explicit extension decision—not another implicit controller around it.

That establishes the architectural departure. It does not establish which departure caused this particular jump, or imply that upstream readers cannot have scrolling bugs.
