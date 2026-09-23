// Injected by lib.rs into the main frame of the bucket window only; reader pages opened in
// an ordinary browser tab never run it. Every capture, new or existing, publishes an
// `open-reader` event (src/server/events.ts): the window asks the window manager for focus
// and moves to the item's reader page, whatever page it was showing. A rejected window
// command propagates out of the listener as an unhandled rejection in the window's console
// and the navigation does not happen.
(bucketOrigin) => {
  if (location.origin !== bucketOrigin) {
    return;
  }
  const events = new EventSource(`${bucketOrigin}/api/events`);
  events.addEventListener("open-reader", async (event) => {
    const { reader_url: readerUrl } = JSON.parse(event.data);
    const bucketWindow = window.__TAURI__.window.getCurrentWindow();
    await bucketWindow.unminimize();
    await bucketWindow.setFocus();
    location.assign(readerUrl);
  });
};
