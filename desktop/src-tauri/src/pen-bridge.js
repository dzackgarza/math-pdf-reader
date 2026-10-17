// Injected into the desktop window only. WebKitGTK currently converts tablet input to mouse
// events; GTK's GestureStylus supplies the actual pen events from the native widget instead.
// A pen is forwarded as a DOM PointerEvent with pointerType 'pen', targeted exactly as a browser
// would hit-test it (including inside EmbedPDF's shadow root). GTK prevents the same native pen
// event from being delivered a second time by WebKit as a mouse event.
(bucketOrigin) => {
  if (location.origin !== bucketOrigin) {
    return;
  }
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
      const { kind, x, y } = payload;
      const type = kind === "pointerhover" ? "pointermove" : kind;
      if (!["pointerdown", "pointermove", "pointerup", "pointercancel"].includes(type)) {
        throw new Error(`Unexpected GTK stylus event: ${kind}`);
      }
      const target = hit(x, y);
      const buttons = kind === "pointerdown" || (kind === "pointermove" && pressed) ? 1 : 0;
      target.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 5,
          pointerType: "pen",
          isPrimary: true,
          bubbles: true,
          composed: true,
          cancelable: true,
          button: 0,
          buttons,
          clientX: x,
          clientY: y,
        }),
      );

      // Dispatching an untrusted PointerEvent does not generate the browser's usual click.
      // Activate the closest native control for a tap; outside controls, activate the HTML
      // element under the pen so row-level click handlers continue to work.
      if (kind === "pointerdown") {
        const control =
          target instanceof Element
            ? target.closest("button, a[href], input, label, summary, [role=button], [role=tab]")
            : null;
        pressed = { control, target, x, y, moved: false };
      } else if (kind === "pointermove" && pressed) {
        if (Math.hypot(x - pressed.x, y - pressed.y) > 6) pressed.moved = true;
      } else if (kind === "pointerup" || kind === "pointercancel") {
        if (
          kind === "pointerup" &&
          pressed &&
          !pressed.moved &&
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
