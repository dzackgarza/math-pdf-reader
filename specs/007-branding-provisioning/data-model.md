# Data Model: Math PDF Reader Identity and Provisioning

All paths are relative to `$XDG_DATA_HOME/pdf-bucket-app` (`installed`) unless they say
otherwise.

## Application Build

The installed desktop runtime.

| Field | Where | Written by |
| --- | --- | --- |
| binary | `~/.local/bin/pdf-bucket-desktop` | `provision.sh:40` |
| runtime files | `dist/web/`, `plugins/manifests/extractions.json`, `.venv/` | `provision.sh:45-54` |
| launcher wrapper | `~/.local/bin/pdf-bucket` (runs `scripts/launch`) | `provision.sh:56-57` |
| entries | `$XDG_DATA_HOME/applications/pdf-bucket-desktop.desktop`, `~/.config/autostart/pdf-bucket-desktop.desktop`, Hyprland drop-in | `provision.sh:60-70` |
| input hash | `source-fingerprint` | `provision.sh:73`, last step of the install |
| input set | paths listed in `scripts/source-fingerprint:7-11` | — |

Rules:
- The hash is taken before the build (`provision.sh:14`). An edit during the build leaves
  the stamp different from the source, so the next launch rebuilds.
- The stamp exists only after a complete install.
- The input set MUST NOT contain extension-only input (FR-005).

## Extension Build

One per browser.

| Field | Chrome | Firefox |
| --- | --- | --- |
| installed files | `extensions/chrome-mv3/` | `extensions/firefox-mv2/`, `extensions/firefox.xpi` (AMO-signed) |
| version | `manifest.json` `version`, `1.0.<commit count>` | same |
| replacement | Chromium reloads the unpacked directory | Firefox update check against `/extension/updates.json` |
| reported at | `/status` `extensions.chrome` | `/status` `extensions.firefox` |

Shared field: `extension-fingerprint`, one hash of the extension input
(`provision-extensions.sh:12-13`) for both browsers, written last
(`provision-extensions.sh:62`).

Rules:
- `/status` reports `null` for a browser whose build directory holds no manifest
  (`server/src/extensions.rs:50-66`).
- A loaded extension whose version differs from a non-null reported version MUST refuse
  every capture and Send tabs (FR-008).

## Provisioning State

The spec's state for each build family. The table gives where the source derives it today.

| State | Application Build | Extension Build |
| --- | --- | --- |
| current | stamp equals the hash of the checkout; known only inside `scripts/launch` | own version equals the reported version |
| stale | stamp differs; the launcher rebuilds; not shown in a running app | own version differs: badge `OLD`, popup, refusal |
| failed | rebuild exit status in the terminal and a notification; not kept | `provision-extensions.sh` exit status in the shell; not kept |
| not provisioned | no binary or no stamp: the launcher rebuilds | reported `null`: the extension treats it as current |

Transitions (application):

```text
not provisioned --provision ok--> current
current --input edit/commit/checkout--> stale
stale --launch: provision-for-launch ok--> current --exec app
stale --launch: provision-for-launch fails--> failed (launch exits 1, app not started)
failed --launch--> stale path again (stamp unchanged)
```

Transitions (each extension):

```text
not provisioned --_provision-extensions ok--> current
current --_provision-extensions with new version--> stale (loaded build)
stale --Chromium reload / Firefox update check--> current
```

FR-007 requires the user to see these states. The gaps are in [plan.md](plan.md#gaps).
