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
