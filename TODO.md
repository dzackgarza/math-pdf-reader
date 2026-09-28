# TODO

## Ownership: Zotero owns bibliographic metadata

This app must not create or send BibTeX. Zotero owns how to get bibliographic information from a source.
"Send to Zotero" passes the item's PDF URL to the local write API's `import_from_url`, and nothing else.
When Zotero must understand more kinds of URL, the write API absorbs that work, not this app.
The roadmap's Decision Log records this decision (2026-09-28).

Tasks:

1. Close [zotero-local-write-api#31](https://github.com/dzackgarza/zotero-local-write-api/issues/31): `import_from_url` finds metadata for a relatively arbitrary source. Its methods are Zotero's web translators, page metadata (`citation_*`, Dublin Core), an identifier in the URL or the page, BibTeX the source publishes, searches of metadata services, and recognition of the PDF. OpenAlex and MathSciNet are not searched yet, because they need credentials.

2. Delete the resolver plugins (`src/resolvers/*.ts`, `plugins/manifests/resolvers.json`) from this app. They still give an item its title (Retrieve metadata, `server/src/library.rs`), so that feature needs a new source first.
