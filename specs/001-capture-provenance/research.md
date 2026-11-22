# Research: PDF Capture and Provenance

## Decision: Preserve the shared cross-browser eligibility predicate

**Rationale:** `src/extension/interception.ts` and
`src/extension/firefox-interception.ts` already express the required MIME,
filename, path, GET, frame, and own-origin rules. Keeping one semantic predicate
prevents Chrome and Firefox from drifting.

**Alternatives considered:** Separate browser-specific eligibility rules were
rejected because the feature requires symmetric behavior and shared fixtures.

## Decision: Keep Chrome download capture and Firefox response streaming

**Rationale:** Chrome's declarative response rules cannot expose navigation bodies,
so Chrome must rewrite the response into a download and submit the saved path.
Firefox can use `webRequest` and `filterResponseData` to stream the response body.
This is an external browser-platform constraint, not an implementation preference.

**Alternatives considered:** A single response-body strategy was rejected because
Chrome and Firefox do not expose equivalent interception APIs.

## Decision: Keep provenance embedded in the PDF and treat the index as derived

**Rationale:** `server/src/store.rs` already stages bytes, computes the original
SHA-256, embeds URL/time/hash metadata, and writes the durable PDF. This directly
preserves the constitution's provenance invariant across reindexing.

**Alternatives considered:** A sidecar-only provenance record was rejected because
it would fail when the index is rebuilt or the PDF is moved independently.

## Decision: Preserve local bytes and recover original URL before mirrors

**Rationale:** `server/src/sources.rs` already verifies fetched bytes against the
original hash and tries the provenance URL before mirror locations. Recovery must
remain explicit and must not replace a local paper with an unverified response.

**Alternatives considered:** Replacing from the first reachable URL was rejected
because reachability does not establish that the bytes are the captured paper.

## Decision: Use the existing SSE open-reader event for reader opening and focus

**Rationale:** Successful capture already publishes `open-reader`, and the Tauri
desktop listener brings the window forward. The plan should strengthen observable
failure behavior for Wayland sessions and Wayland timing rather than create a
second launch protocol. Other desktop sessions are outside this feature's focus
validation boundary.

**Alternatives considered:** Direct extension-to-Tauri control was rejected because
the local server is the existing boundary shared by both browsers and the library.

## Decision: Treat the recovery validation corpus as a named fixture module

**Rationale:** SC-003 requires an aggregate restoration rate over fixtures whose
original or mirror source serves matching bytes. Keeping the corpus in
`tests/fixtures/recovery-cases.ts` makes the classification explicit and lets the
source-recovery integration test calculate the threshold from the same cases.

**Alternatives considered:** Inferring the corpus from individual test assertions
was rejected because it would make the measurable population implicit and fragile.

## Decision: Validate through existing repository gates and focused fixtures

**Rationale:** The repository already has Bun, Rust, Python, browser-manifest, and
source-recovery tests plus `just` QC recipes. New tests should target the missing
boundaries: exact interception parity, actionable failures, focus/event behavior,
original-before-mirror ordering, and provenance retention.

**Alternatives considered:** A new test framework or a broad rewrite of existing
fixtures was rejected as unnecessary and contrary to the repository's wiring-only
architecture.
