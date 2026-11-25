# Research: Runtime Foundation

## Decision: The desktop process is the bucket server

**Rationale**: `desktop/src-tauri/src/lib.rs` binds the bucket's port on Tauri's Tokio
runtime before it builds the window. The window therefore finds a server that already
answers, and the server's lifetime is the app's lifetime. A second launch exits before
it binds and shows the running window (`tauri-plugin-single-instance`).

**Alternatives considered**: A separate server process or systemd service. Rejected:
it adds a second lifecycle that can be down while the window is up. The tray Quit must
also stop capture.

## Decision: Build freshness is checked at launch, by a source hash

**Rationale**: `scripts/launch` compares `scripts/source-fingerprint` (a hash of every
tracked and untracked build input) with the stamp that `scripts/provision.sh` writes
last. A difference rebuilds before start. A failed rebuild stops the launch. This
catches commits, pulls and uncommitted edits alike. An interrupted provision leaves no
stamp, so the next launch rebuilds.

**Alternatives considered**: Compare git revisions. Rejected: uncommitted edits would
start an old build. Compare binary mtimes. Rejected: the runtime files under
`pdf-bucket-app` are built input too.

## Decision: Start failures go to the window's own page

**Rationale**: The window opens on `desktop/src/index.html`, which the app bundles. When
`start()` fails, or the server task ends, the window shows that page with the report in
its fragment. The page does not depend on the bucket, so it renders when the bucket is
down. A dialog is the fallback only when the app's page never loaded.

**Alternatives considered**: A dialog only. Rejected: the window would stay blank behind
it. Exit on failure. Rejected: the user would see nothing.

## Decision: Addresses derive from the key alone

**Rationale**: `server/src/reader.rs` maps a key to `/pdf/<key>.pdf` and `/read/<key>`
with percent-encoding. The server resolves the key through the index on each request.
The address stays the same across restarts and edition replacement under the same key
(feature 009). The original PDF URL lives only in the PDF's embedded provenance.

**Alternatives considered**: Hash- or session-based addresses. Rejected: the Zotero
Connector and browser bookmarks need an address that never changes.

## Decision: Failure tests use the real launcher and the real release app

**Rationale**: The spec requires visible failure of a real build and a real server.
The launcher test runs `scripts/launch` itself with a scratch home. It injects the
build failure on the command path that the launcher calls and checks that the
installed binary never runs. The window test starts the release app under
WebKitWebDriver with the port already taken, or with no web bundle. It then reads the
page that the window shows.

**Alternatives considered**: Unit tests of `StartFailure` formatting. Rejected: they
do not show that the window displays the report or that the old build stays closed.
