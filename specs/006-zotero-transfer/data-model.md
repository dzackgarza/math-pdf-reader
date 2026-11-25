# Data Model: Deliberate Zotero Transfer

The schemas are in `src/contract/library.ts`. The Rust types in `server/src/contract` are
generated from them. This file maps the spec's entities onto them.

## Citation Transfer

The request is one of three HTTP routes (see [contracts/send-api.md](contracts/send-api.md)).
The durable result is the item's `ZoteroRecord` in `organization.json`:

| Field | Meaning |
| --- | --- |
| `itemKey` | The Zotero item the send writes to; for Send PDF Only, the standalone attachment |
| `sentAt` | When the send found or made the Zotero item |
| `method` | How the write API identified the source, or `standalone_attachment` |
| `steps` | Each completed `SendStep`, recorded after Zotero answered |

`ZoteroStatus` is derived for the library payload (`server/src/send.rs:111-131`):
`unsent`, or `sent` with `pending`, the steps still owed.

### State transitions

```text
unsent --import_from_url ok--> sent(pending = owed steps) --each step ok--> sent(pending = [])
   |                               |                                          |
   | health check or import fails  | a step fails: stays sent(pending ≠ [])   | not Keep offline:
   v                               v  the next send performs only those       v  item removed
unsent (no record)              sent(pending ≠ [])                          (removed.json, trash)
```

A new extraction or note after a completed send adds a pending step again.

## Citation Record

The Zotero item. The bucket does not store it. The send writes `url` (the PDF URL) and
`accessDate` (the capture time, ISO 8601 UTC) on it (`zotero.rs:389-406`). A standalone
attachment has no parent item and no fields step.

## Attachment

| Kind | Step | Zotero child |
| --- | --- | --- |
| PDF | `pdf` | One PDF. It is the bucket's copy, titled "Full Text PDF", unless Zotero's PDF has as many annotations. An item that holds more than one PDF is refused. |
| Extraction Markdown | `markdown` | `<ZoteroKey>_extracted.md` from `<root>/<key>/<key>.md` |
| Note | `note` | One child note for each bucket note, as HTML (`zotero.rs:170-177`) |
