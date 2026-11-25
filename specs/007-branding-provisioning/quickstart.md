# Quickstart: Verify Identity and Provisioning

These checks use the provisioned app. Run them only on the owner's desktop, at a
milestone. Automated tests never run them.

## US1: product name

1. Start the app from the application menu entry "Math PDF Reader".
2. Check the window title, the tray menu ("Show Math PDF Reader", "Quit Math PDF Reader"),
   the library tab title, and each extension's toolbar title and popup.
3. Pass: each shows "Math PDF Reader". No surface shows `pdf-bucket`,
   `pdf-bucket-desktop` or `com.dzackgarza.pdfbucket` as a name or as a command to run.

## US2: launch the current build

1. Quit the app. Edit a file under `src/web/`.
2. Start the app from the menu. Pass: the "Math PDF Reader - Building" terminal opens, the
   build runs, then the app opens with the edit.
3. Quit. Start again with no edit. Pass: no terminal; the app opens at once.
4. Quit. Make a build fail (a syntax error in `src/web/`). Start from the menu. Pass: the
   terminal keeps the error and waits for Enter; a critical notification appears; the old
   app does not open. Revert the edit.
5. Quit. Edit only `src/extension/bucket-status.ts`. Start from the menu. Pass: no
   rebuild.

## US3: separate browser integrations

1. Commit an extension change. Run `just _provision-extensions`.
2. In Chromium, open the popup. Pass: after a reload the popup shows `ON` and the new
   version.
3. In Firefox, before the update check, open the popup. Pass: badge `OLD`, the popup
   shows This build, Provisioned and Replacement; a click on a PDF link does not store
   the PDF.
4. After the update check (at most 120 s), click the same link. Pass: the bucket stores
   it and the reader opens.
5. Check with `curl -s http://127.0.0.1:8770/status | jq .extensions` that both versions
   are the new one.
