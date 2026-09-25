// Injected by lib.rs into the main frame of the bucket window only; reader pages opened in
// an ordinary browser tab never run it.
//
// Every capture, new or existing, publishes an `open-reader` event (server/src/events.rs): the
// window shows itself if it was closed to the tray and moves to the item's reader page,
// whatever page it was showing. A rejected window command propagates out of the listener as an
// unhandled rejection in the window's console and the navigation does not happen.
//
// Whenever the window is shown (a capture, the tray's Show item, a second launch) it asks the
// window manager for focus once it draws its first frame. A Wayland compositor ignores a focus
// request from a surface it has not mapped yet (Hyprland: CWindow::activate), and a request
// sent together with the show arrives before the map.
(bucketOrigin) => {
  if (location.origin !== bucketOrigin) {
    return;
  }
  const bucketWindow = window.__TAURI__.window.getCurrentWindow();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      requestAnimationFrame(() => bucketWindow.setFocus());
    }
  });
  const events = new EventSource(`${bucketOrigin}/api/events`);
  events.addEventListener("open-reader", async (event) => {
    const { reader_url: readerUrl } = JSON.parse(event.data);
    await bucketWindow.show();
    await bucketWindow.unminimize();
    await bucketWindow.setFocus();
    location.assign(readerUrl);
  });
};
