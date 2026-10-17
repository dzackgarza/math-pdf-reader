// Injected into the desktop window only. GTK/GDK identifies the tablet tool even though
// WebKitGTK exposes tablet input to the page as mouse input. View strokes are forwarded as pen
// PointerEvents; editing modes use the original GDK/WebKit stream so buttons and tools receive
// trusted native click and pointer-capture events.
(bucketOrigin) => {
  if (location.origin !== bucketOrigin) {
    return;
  }
  window.addEventListener("bucket-stylus-view-mode", (event) => {
    window.__TAURI__.event
      .emit("bucket-stylus-view-mode", event.detail)
      .catch((error) => console.error("GTK stylus cursor mode:", error));
  });
  const hit = (x, y) => {
    let target = document.elementFromPoint(x, y);
    while (target?.shadowRoot) {
      const inner = target.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === target) break;
      target = inner;
    }
    return target ?? document;
  };
  let pressed = null;
  window.__TAURI__.event
    .listen("stylus-pointer", ({ payload }) => {
      const { kind, x, y, eraser = false } = payload;
      const type = kind === "pointerhover" ? "pointermove" : kind;
      if (!["pointerdown", "pointermove", "pointerup", "pointercancel"].includes(type)) {
        throw new Error(`Unexpected GTK stylus event: ${kind}`);
      }
      const target = hit(x, y);
      const contact = kind === "pointerdown" || (kind === "pointermove" && pressed);
      // GTK identifies the physical eraser. In View it deletes highlights; in editing modes
      // the inverted end is an ordinary pen stroke for whichever EmbedPDF tool is selected.
      let viewer = target instanceof Element ? target.closest("embedpdf-container") : null;
      let root = target.getRootNode();
      // EmbedPDF owns nested shadow trees. The mode belongs to the outer viewer, even when
      // a button or canvas lives in a component's own nested shadow root.
      while (!viewer && root instanceof ShadowRoot) {
        viewer = root.host.closest("embedpdf-container");
        root = root.host.getRootNode();
      }
      // In editing modes, native GTK events must pass into WebKit, not become synthetic
      // events (EmbedPDF's native pointer-capture tools require a registered browser pointer).
      // If a pen press began in View, finish that same press through the bridge even if the
      // button switched the viewer to Annotate before release. Dropping the release strands
      // controls without a click and can strand the reader's temporary highlighter state.
      if (type === "pointerdown" && viewer?.dataset.bucketStylusMode === "edit") {
        pressed = null;
        return;
      }
      if (viewer?.dataset.bucketStylusMode === "edit" && pressed === null) {
        return;
      }
      const eraseHighlights =
        pressed?.eraseHighlights ?? (eraser && viewer?.dataset.bucketStylusMode === "view");
      // Pointer Events specifies button 5 / buttons 32 for a pen eraser. Forward the
      // native GdkDeviceToolType rather than inventing a second input protocol.
      const pointer = new PointerEvent(type, {
        pointerId: 5,
        pointerType: "pen",
        isPrimary: true,
        bubbles: true,
        composed: true,
        cancelable: true,
        button: kind === "pointerdown" || kind === "pointerup" ? (eraseHighlights ? 5 : 0) : -1,
        buttons: contact ? (eraseHighlights ? 32 : 1) : 0,
        clientX: x,
        clientY: y,
      });
      target.dispatchEvent(pointer);

      // Dispatching an untrusted PointerEvent does not generate the browser's usual click.
      // Activate the closest native control for a tap; outside controls, activate the HTML
      // element under the pen so row-level click handlers continue to work.
      if (kind === "pointerdown") {
        const control =
          target instanceof Element
            ? target.closest("button, a[href], input, label, summary, [role=button], [role=tab]")
            : null;
        pressed = {
          control,
          target,
          x,
          y,
          moved: false,
          eraseHighlights,
          // A toolbar button can prevent pointerdown while still needing its normal click.
          // Only a consumed eraser stroke must prevent the bridge's synthetic click.
          handled: eraseHighlights && pointer.defaultPrevented,
        };
      } else if (kind === "pointermove" && pressed) {
        if (Math.hypot(x - pressed.x, y - pressed.y) > 6) pressed.moved = true;
      } else if (kind === "pointerup" || kind === "pointercancel") {
        if (
          kind === "pointerup" &&
          pressed &&
          !pressed.moved &&
          !pressed.handled &&
          (pressed.control?.contains(target) ||
            (pressed.target instanceof Element && pressed.target.contains(target)))
        ) {
          const clickable =
            pressed.control ?? (pressed.target instanceof HTMLElement ? pressed.target : null);
          clickable?.click();
        }
        pressed = null;
      }
    })
    .catch((error) => console.error("GTK stylus bridge:", error));
};
