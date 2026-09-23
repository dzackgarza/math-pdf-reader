// Injected by lib.rs into the main frame of the bucket window only; reader pages opened in
// an ordinary browser tab never run it. Every capture, new or existing, publishes an
// `open-reader` event (src/server/events.ts): the window asks the window manager for focus
// and moves to the item's reader page, whatever page it was showing.
(bucketOrigin) => {
  if (location.origin !== bucketOrigin) {
    return;
  }
  const events = new EventSource(`${bucketOrigin}/api/events`);
  events.addEventListener("open-reader", (event) => {
    const { reader_url: readerUrl } = JSON.parse(event.data);
    const bucketWindow = window.__TAURI__.window.getCurrentWindow();
    void bucketWindow.unminimize();
    void bucketWindow.setFocus();
    location.assign(readerUrl);
  });
};
