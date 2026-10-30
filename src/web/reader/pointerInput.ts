// The reader's pointer and key input over EmbedPDF's viewer: a secondary press keeps the text
// selection, Delete removes the selected annotations in Annotate, and a pen highlights in View
// and its eraser deletes annotations in View (highlights) and Annotate (any).

import {
  expandRect,
  type PdfAnnotationObject,
  PdfAnnotationSubtype,
  type Rect,
  rectFromPoints,
} from "@embedpdf/models";
import type { PDFViewerRef } from "@embedpdf/react-pdf-viewer";
import { type RefObject, useEffect } from "react";
import { activeToolbar, type Capabilities, PAGE_BOX, type ReaderHost } from "./readerHost";

// The reader's text-markup highlighter, the tool a stylus always draws with.
const HIGHLIGHT_TOOL = "highlight";

type Point = { x: number; y: number };
type Box = { left: number; top: number; right: number; bottom: number };
type Annotations = ReturnType<Capabilities["annotations"]["forDocument"]>;
type Scroll = ReturnType<Capabilities["scroll"]["forDocument"]>;
type Tracked = ReturnType<Annotations["getAnnotations"]>[number];

function containerOf(viewerRef: RefObject<PDFViewerRef | null>): HTMLElement {
  const container = viewerRef.current?.container;
  if (container === null || container === undefined) {
    throw new Error("the reader's viewer has no container");
  }
  return container;
}

// Whether a pointer event's path holds a page box: a press on a page, not on the toolbar or a
// sidebar.
function onPage(event: Event): boolean {
  return event.composedPath().some((node) => node instanceof Element && node.matches(PAGE_BOX));
}

// A press of a button other than the primary one (the context menu's) leaves the text
// selection as it is: EmbedPDF's selection clears on every press, and its pointer events carry
// no button, so the reader pauses EmbedPDF's interaction manager until the button is released,
// and the selection menu (with its highlight) stays on the selected text.
export function useSecondaryPress(viewerRef: RefObject<PDFViewerRef | null>, host: ReaderHost) {
  useEffect(() => {
    const container = containerOf(viewerRef);
    let paused = false;
    const pressed = (event: PointerEvent) => {
      if (event.button === 0 || event.pointerType === "pen" || host.caps === null) {
        return;
      }
      paused = true;
      host.caps.interaction.pause();
    };
    const released = () => {
      if (paused) {
        paused = false;
        host.caps?.interaction.resume();
      }
    };
    const menu = (event: MouseEvent) => {
      if (onPage(event)) {
        event.preventDefault();
      }
    };
    container.addEventListener("pointerdown", pressed, { capture: true });
    container.addEventListener("contextmenu", menu);
    window.addEventListener("pointerup", released, { capture: true });
    window.addEventListener("pointercancel", released, { capture: true });
    window.addEventListener("blur", released);
    return () => {
      container.removeEventListener("pointerdown", pressed, { capture: true });
      container.removeEventListener("contextmenu", menu);
      window.removeEventListener("pointerup", released, { capture: true });
      window.removeEventListener("pointercancel", released, { capture: true });
      window.removeEventListener("blur", released);
    };
  }, [viewerRef, host]);
}

// Delete or Backspace with no modifier, not yet handled.
function isPlainDelete(event: KeyboardEvent): boolean {
  if (event.key !== "Delete" && event.key !== "Backspace") {
    return false;
  }
  return !(
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.isComposing
  );
}

// Whether a key goes to a field or editable text, which keeps the key's own behaviour.
function typing(event: KeyboardEvent): boolean {
  return event
    .composedPath()
    .some(
      (node) =>
        node instanceof Element &&
        (node.matches(
          "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
        ) ||
          (node instanceof HTMLElement && node.isContentEditable)),
    );
}

// The annotations of the PDF shown while its Annotate toolbar is open; null otherwise.
function annotating(host: ReaderHost): Annotations | null {
  if (host.caps === null || activeToolbar(host) !== "annotation-toolbar") {
    return null;
  }
  const documentId = host.caps.documents.getActiveDocumentId();
  return documentId === null ? null : host.caps.annotations.forDocument(documentId);
}

// EmbedPDF's Annotation plugin owns selection and deletion but binds no Delete/Backspace
// shortcut in the viewer. Keep those keys scoped to the visible Annotate toolbar; inputs,
// editable annotation text and modifier-key shortcuts retain their native behavior.
export function useAnnotationDelete(shown: boolean, host: ReaderHost) {
  useEffect(() => {
    if (!shown) {
      return;
    }
    const pressed = (event: KeyboardEvent) => {
      if (!isPlainDelete(event) || typing(event)) {
        return;
      }
      const scope = annotating(host);
      if (scope === null) {
        return;
      }
      const selected = scope
        .getSelectedAnnotations()
        .filter(({ object }) => object.type !== PdfAnnotationSubtype.LINK);
      if (selected.length === 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      scope.deleteAnnotations(
        selected.map(({ object }) => ({
          pageIndex: object.pageIndex,
          id: object.id,
        })),
      );
    };
    document.addEventListener("keydown", pressed, { capture: true });
    return () => document.removeEventListener("keydown", pressed, { capture: true });
  }, [shown, host]);
}

// The stylus mode a toolbar names: View has none open, Annotate its annotation-toolbar.
export function stylusMode(toolbar: string | null): "view" | "annotate" | "edit" {
  if (toolbar === null) {
    return "view";
  }
  return toolbar === "annotation-toolbar" ? "annotate" : "edit";
}

// View forces pen highlighting; Annotate keeps pen tools native but its eraser deletes
// annotations. Other editing modes retain their existing native input.
export function useStylusModeReport(shown: boolean, host: ReaderHost) {
  useEffect(() => {
    if (!shown) {
      return;
    }
    const toolbar = activeToolbar(host);
    if (toolbar !== undefined) {
      window.dispatchEvent(new CustomEvent("bucket-stylus-mode", { detail: stylusMode(toolbar) }));
    }
  }, [shown, host]);
}

// Liang–Barsky segment/rectangle clipping with a 3 CSS-pixel nib tolerance. Intersect the
// complete distance between samples: fast eraser movement must not skip an annotation.
function crosses(from: Point, to: Point, box: Box): boolean {
  let enter = 0;
  let leave = 1;
  for (const [start, delta, lo, hi] of [
    [from.x, to.x - from.x, box.left - 3, box.right + 3],
    [from.y, to.y - from.y, box.top - 3, box.bottom + 3],
  ]) {
    if (delta === 0) {
      if (start < lo || start > hi) {
        return false;
      }
      continue;
    }
    const a = (lo - start) / delta;
    const b = (hi - start) / delta;
    enter = Math.max(enter, Math.min(a, b));
    leave = Math.min(leave, Math.max(a, b));
    if (enter > leave) {
      return false;
    }
  }
  return true;
}

// Whether the eraser deletes TRACKED: in View only highlights, in Annotate any annotation but
// links, form fields and locked or read-only ones.
function erasable(tracked: Tracked, annotate: boolean): boolean {
  const annotation = tracked.object;
  if (tracked.commitState === "deleted") {
    return false;
  }
  if (!annotate) {
    return annotation.type === PdfAnnotationSubtype.HIGHLIGHT;
  }
  return (
    annotation.type !== PdfAnnotationSubtype.LINK &&
    annotation.type !== PdfAnnotationSubtype.WIDGET &&
    annotation.flags?.includes("locked") !== true &&
    annotation.flags?.includes("readOnly") !== true
  );
}

// The parts of ANNOTATION an eraser hits, in page units. Text markup is a union of disjoint
// glyph rectangles, not one bounding box. Ink has independent pen strokes; test their short
// segment bounds rather than deleting unrelated ink in the whitespace between distant strokes.
// For shapes, stamps, and notes EmbedPDF's own annotation rectangle supplies the hit region.
function hitRegions(annotation: PdfAnnotationObject): Rect[] {
  if (annotation.type === PdfAnnotationSubtype.INK) {
    const nib = annotation.strokeWidth / 2;
    return annotation.inkList.flatMap(({ points }) =>
      points.length < 2
        ? points.map((point) => expandRect(rectFromPoints([point]), nib))
        : points.slice(1).map((point, i) => expandRect(rectFromPoints([points[i], point]), nib)),
    );
  }
  return "segmentRects" in annotation && Array.isArray(annotation.segmentRects)
    ? annotation.segmentRects
    : [annotation.rect];
}

// One rendered page: its index, its place in the scroll layout and its box on screen.
type ShownPage = { pageIndex: number; entire: Rect; visible: DOMRect };

// The pages the viewer draws now, or null between page layouts. The reader's rendered page boxes
// are in the same order as the scroll plugin's renderedPageIndexes. EmbedPDF's own page-rect
// transforms keep rotation, zoom, page dimensions and the scroll strategy in agreement with the
// annotations it paints.
function shownPages(root: ShadowRoot, scroll: Scroll): ShownPage[] | null {
  const boxes = [...root.querySelectorAll<HTMLElement>(PAGE_BOX)];
  const indexes = scroll.getMetrics().renderedPageIndexes;
  if (boxes.length !== indexes.length) {
    return null;
  }
  const pages = scroll.getLayout().virtualItems.flatMap((item) => item.pageLayouts);
  return boxes.flatMap((box, i) => {
    const pageIndex = indexes[i];
    const page = pages.find((candidate) => candidate.pageIndex === pageIndex);
    if (page === undefined) {
      return [];
    }
    const entire = scroll.getRectPositionForPage(pageIndex, {
      origin: { x: 0, y: 0 },
      size: { width: page.width, height: page.height },
    });
    const visible = box.getBoundingClientRect();
    const empty = entire === null || entire.size.width === 0 || entire.size.height === 0;
    return empty || visible.width === 0 || visible.height === 0
      ? []
      : [{ pageIndex, entire, visible }];
  });
}

// Where SEGMENT of a page's annotation lies on screen, or null when EmbedPDF places it nowhere.
function onScreen(scroll: Scroll, page: ShownPage, segment: Rect): Box | null {
  const rect = scroll.getRectPositionForPage(page.pageIndex, segment);
  if (rect === null) {
    return null;
  }
  const { entire, visible } = page;
  const left =
    visible.left + ((rect.origin.x - entire.origin.x) / entire.size.width) * visible.width;
  const top =
    visible.top + ((rect.origin.y - entire.origin.y) / entire.size.height) * visible.height;
  return {
    left,
    top,
    right: left + (rect.size.width / entire.size.width) * visible.width,
    bottom: top + (rect.size.height / entire.size.height) * visible.height,
  };
}

// The eraser, moved from FROM to TO, deletes each annotation of the PDF shown it crosses.
function eraseBetween(host: ReaderHost, root: ShadowRoot | null, from: Point, to: Point) {
  const documentId = host.caps === null ? null : host.caps.documents.getActiveDocumentId();
  if (host.caps === null || documentId === null || root === null) {
    throw new Error("eraser reached a reader without its annotation and page geometry");
  }
  const annotate = activeToolbar(host) === "annotation-toolbar";
  const annotations = host.caps.annotations.forDocument(documentId);
  const scroll = host.caps.scroll.forDocument(documentId);
  const pages = shownPages(root, scroll);
  if (pages === null) {
    return;
  }
  const deleted = pages.flatMap((page) =>
    annotations
      .getAnnotations({ pageIndex: page.pageIndex })
      .filter((tracked) => erasable(tracked, annotate))
      .filter((tracked) =>
        hitRegions(tracked.object).some((segment) => {
          const box = onScreen(scroll, page, segment);
          return box !== null && crosses(from, to, box);
        }),
      )
      .map((tracked) => ({ pageIndex: page.pageIndex, id: tracked.object.id })),
  );
  if (deleted.length > 0) {
    annotations.deleteAnnotations(deleted);
  }
}

// Whether the pen's eraser end, or its eraser button, made EVENT.
function isEraser(event: PointerEvent): boolean {
  return event.button === 5 || (event.buttons & 32) !== 0;
}

// The pen in View highlights whatever tool is in hand, and its eraser deletes annotations in
// View and Annotate.
export function usePen(viewerRef: RefObject<PDFViewerRef | null>, host: ReaderHost) {
  useEffect(() => {
    const container = containerOf(viewerRef);
    // True between a pen's press and its release, and the tool it found then.
    let penDown = false;
    let restoring: string | null = null;
    let erasing: number | null = null;
    let eraserLast: Point | null = null;
    const erase = (from: Point, to: Point) => eraseBetween(host, container.shadowRoot, from, to);

    const suppress = (event: PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const eraserMoved = (event: PointerEvent) => {
      if (event.pointerType !== "pen" || event.pointerId !== erasing || eraserLast === null) {
        return;
      }
      const point = { x: event.clientX, y: event.clientY };
      erase(eraserLast, point);
      eraserLast = point;
      suppress(event);
    };
    const eraserEnded = (event: PointerEvent) => {
      if (event.pointerType !== "pen" || event.pointerId !== erasing) {
        return;
      }
      if (event.type === "pointerup" && eraserLast !== null) {
        erase(eraserLast, { x: event.clientX, y: event.clientY });
      }
      erasing = null;
      eraserLast = null;
      suppress(event);
    };
    // A pen press on a page in View or Annotate, while no other stroke is going on.
    const penPress = (event: PointerEvent) => {
      const mode = activeToolbar(host);
      const drawing = mode === null || mode === "annotation-toolbar";
      return (
        event.pointerType === "pen" && drawing && !penDown && erasing === null && onPage(event)
      );
    };
    const pressed = (event: PointerEvent) => {
      if (!penPress(event)) {
        return;
      }
      const documentId = host.caps === null ? null : host.caps.documents.getActiveDocumentId();
      if (host.caps === null || documentId === null) {
        throw new Error("a pen pressed a page before the viewer was ready");
      }
      if (isEraser(event)) {
        erasing = event.pointerId;
        eraserLast = { x: event.clientX, y: event.clientY };
        erase(eraserLast, eraserLast);
        suppress(event); // do not select text, draw, or activate annotations with the eraser
        return;
      }
      if (activeToolbar(host) !== null) {
        return;
      }
      const annotations = host.caps.annotations.forDocument(documentId);
      penDown = true;
      const tool = annotations.getActiveTool();
      restoring = tool === null ? null : tool.id;
      annotations.setActiveTool(HIGHLIGHT_TOOL);
    };
    const restoreTool = () => {
      if (!penDown) {
        return;
      }
      penDown = false;
      const documentId = host.caps === null ? null : host.caps.documents.getActiveDocumentId();
      const previous = restoring;
      restoring = null;
      if (host.caps === null || documentId === null) {
        return;
      }
      const annotations = host.caps.annotations.forDocument(documentId);
      // The stroke leaves the highlighter in hand. A pen press on a toolbar button left that
      // button's tool in hand instead, and the release must not undo the button.
      if (annotations.getActiveTool()?.id === HIGHLIGHT_TOOL) {
        annotations.setActiveTool(previous);
      }
    };
    const lostFocus = () => {
      erasing = null;
      eraserLast = null;
      restoreTool();
    };
    const released = (event: PointerEvent) => {
      if (event.pointerType === "pen") {
        restoreTool();
      }
    };
    container.addEventListener("pointerdown", pressed, { capture: true });
    container.addEventListener("bucket-stylus-mode-changed", lostFocus);
    window.addEventListener("pointermove", eraserMoved, { capture: true });
    window.addEventListener("pointerup", eraserEnded, { capture: true });
    window.addEventListener("pointercancel", eraserEnded, { capture: true });
    // A stroke can finish outside the page or even outside the reader's container.
    window.addEventListener("pointerup", released);
    window.addEventListener("pointercancel", released);
    window.addEventListener("blur", lostFocus);
    return () => {
      container.removeEventListener("pointerdown", pressed, { capture: true });
      container.removeEventListener("bucket-stylus-mode-changed", lostFocus);
      window.removeEventListener("pointermove", eraserMoved, { capture: true });
      window.removeEventListener("pointerup", eraserEnded, { capture: true });
      window.removeEventListener("pointercancel", eraserEnded, { capture: true });
      window.removeEventListener("pointerup", released);
      window.removeEventListener("pointercancel", released);
      window.removeEventListener("blur", lostFocus);
    };
  }, [viewerRef, host]);
}
