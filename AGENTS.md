<!-- agent-memory:start -->
# Agent memory

This repository uses the central agent memory vault at `/home/dzack/.agent-memory-vault`.

Project memory key: `projects/math-pdf-reader/index`.

Repository `.agents` and `.hermes` paths are symlinks to the same vault-owned project directory.

Before changing architecture, search both project and global memory:

```bash
agent-memory search --scope both "<task or subsystem>"
```

Record durable repo-specific lessons with:

```bash
agent-memory add --scope project --type decision --title <title> --content <content>
agent-memory add --scope project --type trap --title <title> --content <content>
agent-memory add --scope project --type advice --title <title> --content <content>
agent-memory add --scope project --type context --title <title> --content <content>
agent-memory add --scope project --type reference --title <title> --content <content>
```

Plan work is card-backed. Create and update plan cards with `agent-memory plan add` and `agent-memory plan update`, not `agent-memory add --type plan`.

Use `agent-memory retrieve <key>`, `agent-memory update <key>`, and `agent-memory delete <key>` for memory CRUD.

The vault should be committed at all times. Treat staged or unstaged vault changes as an ephemeral error state. Before normal memory work resumes, load the bundled vault-maintenance skill with `agent-memory maintain skill vault-maintenance` and follow its referenced check, repair, and commit workflows.

Move reusable lessons during maintenance with:

```bash
agent-memory maintain move <key> --to global/advice
```
<!-- agent-memory:end -->

# PDF Bucket

A standalone desktop app that replaces reading PDFs in the browser. Browser extensions
intercept every PDF navigation in Chrome and Firefox and hand the PDF to the bucket, which
stores a copy with its provenance embedded (PDF URL, source page, capture time, hash),
opens it in a PDF.js reader inside the app window, and lets the user file it into
collections and tags, run extraction plugins on it, and send it to Zotero when it matters.
Zotero stays the citation store; the bucket is the reading store.

## Where the plan is

The plan is a card in the agent-memory vault, not a file in this repo.

```bash
agent-memory plan show PLAN-PDF-BUCKET-ROADMAP     # roadmap: milestones, invariants, decisions
agent-memory feature show FEATURE-PDF-BUCKET       # parent feature
```

Read the roadmap before any change. Milestones M1 (capture extension) and M2 (library UI)
spawn their own implementation-adjacent child plans; write those with `agent-memory plan
add --parent FEATURE-PDF-BUCKET` and complete the type-system prepass first (see the `plan`
skill). Record decisions in the roadmap's Decision Log through `agent-memory plan update`,
never by hand-editing vault Markdown. The card's status says whether the user has
confirmed the current architecture.

## Reuse policy

Nothing in this repo is invented. Two kinds of source, handled differently:

- **Mature external projects** (PDF.js, Tauri, WXT, React, the Zotero Connector, the local
  write API addon): import directly, or fork. Cribbing code from them is also fine.
- **The user's own prior repos** (below): reference implementations. Crib their code into
  this repo because it is already written and debugged, and leave a comment naming the
  source file. Never import them as dependencies, never keep the copies in sync, and never
  treat their decisions as gospel: read them as a starting point that has survived some
  debugging, nothing more.

Reference implementations:

- `~/gitclones/zotero-gui` (`dzackgarza/zotero-gui`): the library UI (table, collections
  sidebar, inspector, command palette), the subprocess resolver plugins and their JSON
  manifest, and the Zotero import path through the local write API.
- `~/gitclones/mathread` (`dzackgarza/mathread`): the capture extension (interception rules,
  link origin, capture-bytes client), provenance embedding with pikepdf, the folder-backed
  store. Its reader, overlay and notes are superseded; do not port them.
- `~/zotero-library` (`zotero-library-tools`): `lib/zotero.py`, the extraction providers
  (MinerU flash, MinerU precise, Mistral OCR), identifier extraction.
- Paperlib (https://paperlib.app) is the reference for the app's shape, not a code source.

## How to follow the mockups

`mockups/` holds four images from the user. They fix the target GUI and the vocabulary.
Following a mockup means finding the element in the reused components or the substrate,
then configuring it; it does not mean writing a new component. If an element has no home in
the reused code or the substrate, that is a Decision Log entry for the user, not a feature
to build from scratch.

| Mockup | Element | Where it lives |
| --- | --- | --- |
| library (1) | Library / Inbox / Offline Cache | bucket index views; every stored item is cached by construction |
| library (1) | Collections, Tags, Saved Searches | `zotero-gui` sidebar and table over the bucket index; topics are a `topic:` tag namespace or saved searches |
| library (1) | Chrome / Firefox capture toggles | capture extension options, one build per browser |
| library (1) | Details: Source, Source URL, First captured, File path, Cache status, SHA256 | provenance embedded in the PDF, shown by the reused inspector |
| library (1) | Send to Zotero | the send action: resolver plugins to BibTeX, then `import_bibtex` and `attach_bytes` on the local write API; or open the reader URL in a browser and press the Zotero Connector |
| reader (2) | reader, outline, search in document, highlights, notes | PDF.js prebuilt viewer in an iframe; highlights saved into the PDF by `saveDocument()` |
| reader (2) | Provenance panel, mirror URLs | embedded provenance; mirrors are later enrichment |
| reader (2) | Rebuild from metadata | the cache-rebuild recipe |
| collections (3) | Smart Collection rules, subcollections | saved searches; nested collections in the index |
| settings (4) | Browser Capture | extension options page |
| settings (4) | Zotero Integration | the local write API on port 23119; library target is Zotero's selected collection |
| settings (4) | Embedded Foundations | PDF.js (reader), WXT extension (capture), subprocess plugins (extraction, resolvers), Zotero Connector and local write API (Zotero bridge), Tauri (window) |

When a mockup and a reused component disagree on a label, keep the component's label in
code and note the mockup term once in the plan's Decision Log.

## Invariants that must always hold

These constrain every milestone, child plan, and commit. A change that satisfies its task
but breaks one of these is wrong.

1. **Provenance travels with the PDF.** Every stored PDF carries PDF URL, source page URL,
   capture time and original SHA-256 inside the file. The index is derivable from the
   files; a sidecar-only record is not provenance.
2. **Everything is a URL.** Every PDF and every reader page is reachable at a stable
   `http://127.0.0.1:<port>/...` URL while the bucket runs. Reader pages carry Highwire
   `citation_*` meta tags so the unmodified Zotero Connector works on them from any browser.
3. **Zotero is written only by the send action or by the user's own connector click.**
   Capture, extraction and library operations never touch Zotero.
4. **Interception is total and symmetric.** Every GET navigation whose response is a PDF
   (`Content-Type`, `Content-Disposition` filename, or `.pdf` path) is intercepted in both
   browsers, except POST responses, small embedded frames, and the bucket's own origin.
   Chrome and Firefox pass the same fixture set.
5. **The bucket being down is visible, not silent.** The capture page shows the error and a
   link to open the PDF natively. No silent native open, no silent drop, no retry loop.
6. **Plugins are commands.** Extraction and resolver plugins are external commands with a
   JSON manifest and contract. The app imports no provider SDK and holds no credentials.
7. **This repo owns wiring only.** No hand-rolled PDF viewer, library table, search index,
   metadata scraper or citation database. PDF.js renders; components cribbed from
   `zotero-gui` display; code cribbed from `mathread` captures; plugins extract; Zotero
   cites. Every cribbed or hand-written piece names the reference it follows.
8. **Every commit leaves the repo and the vault clean.** Plan state lives in the vault card;
   repo docs describe how the system works, never what remains to do.
