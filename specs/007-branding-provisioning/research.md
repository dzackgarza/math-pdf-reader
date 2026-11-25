# Research: Math PDF Reader Identity and Provisioning

The behaviour existed before this spec. Each entry records the decision that the source
shows, its reason from the source comments and docs, and the alternatives they name.

## R1. Application input is a content hash of named paths

- **Decision**: `scripts/source-fingerprint` hashes the content of every tracked and
  untracked, non-ignored file under the build paths. It excludes `src/extension/**` and
  `wxt.config.ts`. Documentation, tests and mockups are outside the list.
- **Rationale**: A commit, a pull, a checkout and an uncommitted edit all change the hash.
  The launcher needs no git state other than the file list.
- **Alternatives considered**: The commit id misses uncommitted edits. File modification
  times change on checkout without a content change.
- **Finding**: The list also names `scripts/amo_signed.py` and `scripts/firefox-policy.sh`.
  Only extension provisioning and `just firefox-policy` read them (`git grep` over the
  checkout, 2026-11-25). They are extension-only input (FR-005).

## R2. The launcher rebuilds in a visible terminal

- **Decision**: `scripts/launch` runs `just provision-for-launch` in a `kitty` window
  titled "Math PDF Reader - Building". On failure the window waits for Enter. The
  launcher sends a critical notification and exits 1.
- **Rationale**: The launcher runs from a desktop entry or from systemd autostart, where
  stderr is not visible. The build output must stay visible (FR-004).
- **Alternatives considered**: A notification alone does not keep the output. Starting
  the old build after a failure presents a stale app as current.
- **Finding**: The output lives only in the terminal. After the user closes it, no record
  of the failure remains.

## R3. Extension version is `1.0.<commit count>`

- **Decision**: `wxt.config.ts:24-27` sets the version from `git rev-list --count HEAD`.
- **Rationale**: Firefox updates an add-on only to a greater version, and AMO signs each
  version once (comment in `wxt.config.ts`).
- **Finding**: Extension input that is not committed builds with the version of the last
  commit. `amo_signed.py` then returns the package AMO signed earlier for that version.
  `firefox.xpi` keeps the earlier code, while `firefox-mv2/` and `extension-fingerprint`
  describe the new input.

## R4. Firefox installs and updates from the bucket by enterprise policy

- **Decision**: `scripts/firefox-policy.sh` force-installs the add-on from
  `/extension/firefox.xpi` and points its update check at `/extension/updates.json`, every
  120 s. AMO signs the build as unlisted (`web-ext sign --channel unlisted`).
- **Rationale**: Release Firefox installs only signed add-ons. The policy makes the
  replacement automatic after provisioning (README, Browser extensions).
- **Alternatives considered** (docs/m5.md): a temporary add-on, an unsigned install in
  Developer Edition, Nightly or ESR.

## R5. Chromium runs the unpacked installed directory

- **Decision**: Chromium loads `extensions/chrome-mv3` unpacked. A stale build reloads
  itself once per provisioned version (`bucket-status.ts:89-96`). A build whose files are
  newer than its loaded manifest reloads at background start (`bucket-config.ts:21-23`).
- **Rationale**: Chromium reads pages and a restarted background from the directory but
  keeps the manifest it loaded, so the two halves can disagree until a reload.

## R6. Test boundary for the launcher

- **Decision**: Tier-1 launcher tests run the real `scripts/launch` and
  `scripts/source-fingerprint` in a scratch git worktree with scratch `HOME` and `XDG_*`
  directories. They substitute `kitty`, `notify-send`, `just` and the installed binary by
  scripts on `PATH` and in the scratch `~/.local/bin`. The substitutes record their
  arguments and exit with a chosen status.
- **Rationale**: The real build takes minutes. `provision.sh:35-37` kills every
  `pdf-bucket-desktop` process and talks to the real systemd user manager, so it would
  stop the owner's app. The launcher's own decisions (rebuild or not, start or not,
  notify, keep output) are observable at these program boundaries.
- **Alternatives considered**: Running the real `provision-for-launch` in tier 1 is slow
  and not isolated. `provision.sh` itself is testable at the same boundary: substitutes
  for `direnv`, `bun`, `bunx`, `uv`, `pgrep`, `killall` and `systemctl` on `PATH`
  (task T024).
