# Research: Library Organization

## R1. Where view membership is computed

- **Decision**: on the client, from the one library payload, in `itemsInView` and
  `itemsMatching` (`src/web/librarySelectors.ts`).
- **Rationale**: a view is a function of the payload. A metadata or filing change produces a
  new payload, so every view and saved search agrees with it at once. US2/AC3 and SC-005
  need no stored membership.
- **Alternatives considered**: stored membership lists on the server. Rejected: they must be
  recomputed on every edit and can disagree with the items.

## R2. Rules on collections

- **Decision**: collection rules are smart collections, which are saved searches with rules
  (`SavedSearchSchema`, `RuleSchema`).
- **Rationale**: roadmap Decision Log (M2): the mockups' "Smart Collection" is a saved search.
- **Alternatives considered**: rules as a field of `Collection`. Not built; it would duplicate
  the saved-search mechanism.

## R3. The Inbox label

- **Decision**: open. The code uses "Unfiled" per the user decision of 2026-09-24 (#17). The
  spec says "Inbox". See the plan's Decision Log.

## R4. Tags as values, not entities

- **Decision**: a tag exists while an item carries it. A saved-search rule that names a tag
  no item carries matches nothing.
- **Rationale**: the filing stores tags on items (`ItemFiling.tags`). No delete-tag operation
  exists, so there is no point at which rules could be repaired.
- **Consequence for the edge case**: the saved search stays and shows an empty result. A test
  must show that the library keeps working and the empty result is explained (T042).
