#!/usr/bin/env bash
# Print the Firefox enterprise policy entries through which Firefox installs and updates the
# capture add-on from the bucket: ExtensionSettings force-installs it from the bucket and points
# its update check at the bucket's update manifest (server/src/extensions.rs), and the add-on
# update check runs every 120 s, as often as Firefox's update timers run
# (app.update.timerMinimumDelay). Policy reference:
# https://mozilla.github.io/policy-templates/#extensionsettings and #preferences.
# Reads the add-on id from the Firefox build in dist/firefox-mv2; run from the repository root.
set -euo pipefail
origin="http://$(jq -r '.server.host + ":" + (.server.port | tostring)' pdf-bucket.config.json)"
id=$(jq -r .browser_specific_settings.gecko.id dist/firefox-mv2/manifest.json)
jq -n --arg id "$id" --arg origin "$origin" '{
  policies: {
    ExtensionSettings: {
      ($id): {
        installation_mode: "force_installed",
        install_url: "\($origin)/extension/firefox.xpi",
        update_url: "\($origin)/extension/updates.json"
      }
    },
    Preferences: {
      "extensions.update.interval": { Value: 120, Status: "locked" }
    }
  }
}'
