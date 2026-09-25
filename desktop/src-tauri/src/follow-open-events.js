// Injected by lib.rs into the main frame of the bucket window only; reader pages, in the
// library's tabs or in an ordinary browser tab, never run it.
//
// Every capture, new or existing, publishes an `open-reader` event (server/src/events.rs): the
// library opens the item's reader in a tab (src/web/tabs.tsx), and the window shows itself if it
// was closed to the tray. A rejected window command propagates out of the listener as an
// unhandled rejection in the window's console.
//
// Whenever the window is shown (a capture, the tray's Show item, a second launch) it asks the
// window manager for focus once it draws its first frame. A Wayland compositor ignores a focus
// request from a surface it has not mapped yet (Hyprland: CWindow::activate), and a request
// sent together with the show arrives before the map.
//
// The tray's Quit emits `quit-requested`. The follower dispatches a `pdf-bucket-quit` event on
// the page, whose `detail.waitUntil(promise)` lets the library hand over the saves it must finish
// (the ExtendableEvent.waitUntil pattern of the Service Worker specification), waits for every
// one, and answers `quit-settled` with `{status: "settled"}` or `{status: "failed", message}`.
(bucketOrigin) => {
  if (location.origin !== bucketOrigin) {
    return;
  }
  const tauri = window.__TAURI__;
  const bucketWindow = tauri.window.getCurrentWindow();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      requestAnimationFrame(() => bucketWindow.setFocus());
    }
  });
  const events = new EventSource(`${bucketOrigin}/api/events`);
  events.addEventListener("open-reader", async () => {
    await bucketWindow.show();
    await bucketWindow.unminimize();
    await bucketWindow.setFocus();
  });
  tauri.event.listen("quit-requested", async () => {
    const pending = [];
    window.dispatchEvent(
      new CustomEvent("pdf-bucket-quit", {
        detail: { waitUntil: (settled) => pending.push(settled) },
      }),
    );
    const outcomes = await Promise.allSettled(pending);
    const failed = outcomes.find((outcome) => outcome.status === "rejected");
    await tauri.event.emit(
      "quit-settled",
      failed === undefined
        ? { status: "settled" }
        : { status: "failed", message: String(failed.reason) },
    );
  });
};
