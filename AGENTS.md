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
  this repo because it is already written and debugged, then treat it as this repo's code.
  Never import them as dependencies, never keep the copies in sync, never treat their
  decisions as gospel, and never name them in code, comments, docstrings, error text or
  user-facing docs: they will not exist when this project is mature. Commit messages are
  the only place their names belong.

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
| library (1) | Collections, Tags, Saved Searches | `zotero-gui`'s sidebar and table, cribbed, over the bucket index; topics are a `topic:` tag namespace or saved searches |
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
   `zotero-gui` display; the capture extension cribbed from `mathread` captures; plugins
   cribbed from `zotero-library-tools` extract; Zotero cites. Cribbing is how this repo
   avoids writing those pieces; the cribbed code carries no mention of where it came from.
8. **Every commit leaves the repo and the vault clean.** Plan state lives in the vault card;
   repo docs describe how the system works, never what remains to do.

# Review Guidelines

These are additional requirements for reviewing agent work.
They do not replace the reviewer’s normal role, repo-specific standards, or technical judgment.
They provide the failure model that should shape the review.

The task is not merely to review a PR. The task is to decide whether a completion claim is true under the original objective.
The standard is full, correct, provable completion against the original requirements and repo guidelines.
Anything less is incomplete work that must not be treated as a win.

## Failure Model

Agents systematically produce impressive non-completion.
Common patterns are: polished summaries that imply finished work, caveats that quietly narrow the goal, reclassification without proof, delegated discovery presented as resolution, process language that substitutes for evidence, merged PRs treated as completion, passing checks treated as semantic proof, and artifacts that look substantial while leaving required work unowned.

Treat the agent’s summary, PR description, closing comment, issue closure, “goal completed” statement, and self-reported validations as untrusted.
They may be diagnostic pointers, but they are not evidence that the work is complete.
The evidence is the original issue or task, the code diff, tests, source/runtime facts, review comments, and produced artifacts.

## Decisive Invariants

Preserve the original success condition.
Read the original issue or task before accepting any restatement of it.
Keep its quantifiers intact: “all,” “complete,” "full subset," “zero remaining,” and similar terms cannot be quietly narrowed to examples, partial coverage, known blockers, or whatever the PR happened to touch.

Nothing required may disappear silently.
A required work family must be implemented, explicitly falsified, or validly reclassified with evidence that satisfies the issue’s own standard.
Partial implementation is not completion.
Future work is not completion.
Count reduction is not completion.
Resolved review threads are not completion.
Passing checks are not completion.
Substantial-looking work is not completion.
“Better than before” is not completion.

Goal substitution is the main thing to detect.
Ask whether the submitted work solves the original problem or merely produces a narrower artifact: cleaner metadata, a partial subset, a better explanation, a new issue, a renamed scope, a local workaround, or proof that someone should investigate later.

Technically correct administrative artifacts can be goal substitution.
A well-written issue, comment, audit note, scope statement, or enumeration of remaining work may be required, but it does not complete implementation, testing, proof, or downstream cleanup.
If the original task requires execution, the artifact is only useful insofar as it drives that execution; it must not become the stopping point.

Treat self-scoped remaining-work lists as a severe completion-laundering pattern.
When an agent is asked to enumerate remaining work, the domain is the original full completion requirement, not the agent’s intended subset, the PR’s current shape, a closeability criterion, or the work left after deferral and reclassification.
A valid enumeration subtracts only artifact-proven completed work from the original contract.
Deferrals, routed follow-ups, owner changes, and truthful incompletion notes remain unresolved work unless the original task explicitly made that administrative routing the whole deliverable.

If an agent repeats a narrowed enumeration after being corrected, treat that as a hard misalignment signal, not as an innocent wording issue.
The reviewer should identify the original full requirement, the scope the agent substituted, and the required work hidden by that substitution.

Silent reclassification is not resolution.
If the PR says remaining work is out-of-scope, research-owned, stub-owned, plugin-owned, downstream-owned, or future-owned, require evidence from the relevant source/runtime behavior, repo boundary, or original acceptance criteria.
A sentence in the PR description is not enough.

Ownership boundaries matter.
The submitting repo must prove its own claimed behavior and do the blocker forensics required by its own issue.
Do not require a receiving or downstream repo to classify another project’s internal uncertainty unless the original issue explicitly made that part of acceptance.
When an external issue is created, it should be written for that receiving repo, not for a reader who already knows the submitting repo’s context.

## Evidence Expectations

Review tests as evidence, not as decoration.
Valid tests exercise the real production path or semantic requirement.
Be skeptical of helper-only tests, tautologies, assertions of the implementation’s own output, bypasses around the runtime/plugin/stub path, example-only coverage where the issue required full coverage, weakened assertions, and missing invalid-nearby cases where the fix could overgeneralize.

For plugin work, the evidence should usually distinguish valid generic behavior from invalid nearby ordinary Python and should not hard-code a downstream consumer.
For stubs work, the evidence should be source-backed: the upstream surface exists, the stub matches public behavior, no fake API is added, no Any/object opacity escape is introduced, and inherited-method inflation is not used unless source exposes that surface.

Watch for code-level laundering: hard-coded consumer names, support for local research abstractions as if they were external API, fake stubs, broad Any/object escapes, line suppressions, diagnostic filtering, deletion of required data, broad type widening, and any move that makes checks pass by weakening the problem instead of solving it.

## When Acting on Review Feedback

A positive disposition requires a commit.

Do not resolve an accepted review comment until the code/proof remediation is committed and the reply cites the commit.

Never reply “accepted,” “aligned,” “fixed,” “addressed,” or “will address” to a review thread unless the remediation is already committed.
A thread cannot be resolved on intent or future work.

Every substantive review item must receive its visible thread- or surface-local disposition and evidence before resolution.
The canonical field contract and state machine live in [[pr-feedback-triage/SKILL|pr-feedback-triage]]. Do not create top-level disposition ledgers or tracked review-log files.
Migrate legacy ledger-only resolutions by posting the canonical disposition and evidence on each affected thread before treating it as closed.

Review comments are not implementation specs.
The worker must translate accepted feedback into first-principles remediation requirements before assigning implementation.

For each comment:
- Identify the concern.
- Identify the proposed fix.
- Decide whether the concern is true under global + repo policy.
- Decide whether the proposed fix preserves those policies.
- If the concern is true but the fix is wrong, apply a policy-compatible remediation.

## Writing the Review

Write nuanced feedback for an intelligent reader.
Do not force a machine-readable template, a mandatory table, or a simplistic pass/fail label when prose communicates the situation better.
Do make the completion judgment clear: whether the original task can be considered complete, what evidence supports that judgment, and which unresolved requirements block completion if any remain.

Do not foreground effort, progress, good intentions, volume of work, or “substantial” partial implementation when required work remains.
Mention completed pieces only when they are necessary to identify the exact remaining blockers or to prevent redoing already-correct work.
Do not compare incomplete work to “no work done” or “completely fake work”; compare it to the expected standard: the task done correctly, completely, and provably.

When required work remains, lead with the incompleteness and the concrete blockers.
Do not make the reader excavate the missing work from beneath praise, context-setting, or a narrative of what did get done.

Nuance belongs in the evidence and blocker analysis, not in softening the completion standard.
The review should make it easy to finish the work, not easy to feel satisfied with less than the original contract required.
