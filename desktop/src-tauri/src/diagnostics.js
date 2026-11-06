// Injected by lib.rs into the main frame of the bucket window; diagnostics.rs is its native half.
//
// Reports what the page sees to the app's log as `diag-page` events: uncaught errors, unhandled
// rejections, visibility and page-lifecycle changes, and lost or restored canvas contexts
// (`webglcontextlost` for WebGL, `contextlost` for a 2D canvas, HTML Living Standard). Each event
// carries `kind`.
//
// `probe(id)` answers the app's frame probe twice: `probe` at once, which shows the page's
// script runs, then `frame` from the next animation frame, which shows the page still draws. A
// probe answered without a frame means the web process runs but produces no frames.
(bucketOrigin) => {
  if (location.origin !== bucketOrigin) {
    return;
  }
  const tauri = window.__TAURI__;
  // A report that cannot reach the app has nowhere else to go: the native half logs the probes
  // that went unanswered, which shows a broken channel.
  const send = (kind, detail) =>
    tauri.event
      .emit("diag-page", { kind, ...detail })
      .catch((error) => console.error("diag-page could not be sent", error));
  const state = () => ({
    visibility: document.visibilityState,
    focused: document.hasFocus(),
    width: window.innerWidth,
    height: window.innerHeight,
    pixelRatio: window.devicePixelRatio,
    url: location.href,
  });
  window.addEventListener("error", (event) =>
    send("error", {
      message: event.message,
      source: `${event.filename}:${event.lineno}:${event.colno}`,
    }),
  );
  window.addEventListener("unhandledrejection", (event) =>
    send("unhandledrejection", { reason: String(event.reason) }),
  );
  document.addEventListener("visibilitychange", () => send("visibilitychange", state()));
  window.addEventListener("pageshow", (event) =>
    send("pageshow", { persisted: event.persisted, ...state() }),
  );
  window.addEventListener("pagehide", (event) =>
    send("pagehide", { persisted: event.persisted }),
  );
  for (const kind of ["webglcontextlost", "webglcontextrestored", "contextlost", "contextrestored"]) {
    document.addEventListener(kind, (event) => send(kind, { target: event.target.outerHTML.slice(0, 120) }), true);
  }
  window.__bucketDiagnostics = {
    probe(id) {
      const asked = performance.now();
      send("probe", { id, ...state() });
      requestAnimationFrame(() =>
        send("frame", { id, delayMs: Math.round(performance.now() - asked) }),
      );
    },
  };
  send("loaded", state());
};
