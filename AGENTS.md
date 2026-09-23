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

An always-on reading bucket for PDFs. Browser extensions intercept every PDF navigation in
Chrome and Firefox and load the PDF in the bucket instead of the browser. The bucket keeps
a persistent local copy plus the provenance needed to rebuild it (URL, access date,
filename). The user files items into collections and tags, reads them, and promotes the
ones worth citing to the main Zotero library.

## Where the plan is

The plan is a card in the agent-memory vault, not a file in this repo.

```bash
agent-memory plan show PLAN-PDF-BUCKET-ROADMAP     # roadmap: milestones, invariants, decisions
agent-memory feature show FEATURE-PDF-BUCKET       # parent feature
```

Read the roadmap before any change. Milestones M1 (hijack extension) and M3 (promotion)
spawn their own implementation-adjacent child plans; write those with `agent-memory plan
add --parent FEATURE-PDF-BUCKET` and complete the type-system prepass first (see the `plan`
skill). Record decisions in the roadmap's Decision Log through `agent-memory plan update`,
never by hand-editing vault Markdown.

The substrate decision (a second Zotero instance as the bucket, with Karakeep as the
fallback) is recorded in the roadmap Decision Log; the card status shows whether the user
has confirmed it. Do not reopen it in a child
plan. Prior art that shaped it: `~/gitclones/mathread` (superseded), the transcript
`~/gitclones/Provenance-based-Reading-System.md` (user messages are authoritative, the
model's replies are not), and the Zotero multi-instance documentation.

## How to follow the mockups

`mockups/` holds four images from the user. They fix the target GUI and the vocabulary.
They are not a spec for code to write: the bucket's GUI is Zotero's, so following a
mockup means mapping each element to the native Zotero surface that already provides it,
then configuring that surface. If an element has no native surface, that is a Decision Log
entry for the user, not a feature to build.

| Mockup | Element | Native surface in the bucket instance |
| --- | --- | --- |
| library (1) | Library / Inbox / Offline Cache | library root; an `Inbox` collection or "unfiled items"; all items are cached by construction |
| library (1) | Collections | Zotero collections |
| library (1) | Topics | tags with a `topic:` prefix, or saved searches; no third taxonomy exists |
| library (1) | Tags | Zotero tags; up to nine colored tags get number-key hotkeys |
| library (1) | Saved Searches | Zotero saved searches |
| library (1) | Chrome / Firefox capture toggles | the hijack extension's pause toggle, one per browser |
| library (1) | Details: Source, Source URL, First captured, File path, Cache status | attachment `url`, `accessDate`, file path; the item pane |
| library (1) | Send to Zotero | colored tag `zotero` (hotkey `1`) consumed by the promotion script; or View Online plus the unmodified Zotero Connector |
| reader (2) | reader, outline, notes, highlights, search in document | the Zotero reader |
| reader (2) | Provenance panel, mirror URLs, SHA256 | `url` and `accessDate` on the attachment; mirrors and hashes are later enrichment, not capture |
| reader (2) | Rebuild from metadata | the cache-rebuild recipe (M4) |
| collections (3) | Smart Collection rules | saved searches |
| collections (3) | Subcollections | nested collections |
| settings (4) | Browser Capture | extension options page |
| settings (4) | Zotero Integration, library target | the main instance's write API on its port; the bucket never selects a target inside the main library |
| settings (4) | Embedded Foundations | Zotero (GUI, reader, storage), Zotero Connector (capture and promotion), pdf.js interception rules (extension) |

When a mockup and Zotero disagree on a label, use Zotero's label in code and docs, and
note the mockup term once in the plan's Decision Log.

## Invariants that must always hold

These constrain every milestone, child plan, and commit. A change that satisfies its task
but breaks one of these is wrong.

1. **Provenance is total.** Every item in the bucket has a non-empty URL and an access
   date. Capture without a URL is not capture; it fails loudly.
2. **The main Zotero library is written only by the promotion action or by the user
   pressing the unmodified Zotero Connector.** The hijack path, the connector build that
   targets the bucket, and every script in this repo write to the bucket port only.
3. **Interception is total and symmetric.** Every GET navigation whose response is a PDF
   (by `Content-Type`, `Content-Disposition` filename, or `.pdf` path) is intercepted in
   both browsers, except responses from the bucket's own origin and except POST responses.
   Chrome and Firefox must behave the same on the same fixture set.
4. **The bucket being down is visible, not silent.** The capture page shows the failure
   and a manual link to open the PDF natively. No silent native open, no silent drop, no
   retry loop.
5. **Losing every cached file loses no provenance.** The bucket database alone must be
   enough to re-download every item whose URL is still live, and to report by key the
   ones that are not.
6. **This repo owns glue only.** Extension manifests and one small background script, a
   prefs seed, a systemd unit, the connector build configuration, the promotion script,
   the cache-rebuild recipe. No PDF viewer, no library UI, no database schema, no
   metadata extractor. If a task seems to need one, use the substrate's or stop and ask.
7. **Own code stays smaller than any single dependency it wires.** Hand-rolled code cites
   the reference implementation it follows (the pdf.js interception rules, the Zotero
   Connector, `lib/zotero.py`).
8. **Every commit leaves the repo and the vault clean.** Plan state lives in the vault
   card; repo docs describe how the system works, never what remains to do.
