// Where each open PDF is, and the reader's own moves to a place, which record no jump.

import { useCallback } from "react";
import type { Position } from "./documentStorage";
import type { Capabilities, ReaderHost } from "./readerHost";

export function usePositions(host: ReaderHost, caps: () => Capabilities) {
  // Where KEY is now. The viewport's top-left corner lies in the first page it shows; the page
  // coordinates of that corner are the visible part's offset in the page, less the gap above or
  // beside the page, in page units. EmbedPDF's scrollToPage adds the viewport's gap to the place
  // these coordinates name (plugin-scroll's getScrollPositionForPage), so they hold it less.
  const positionOf = useCallback(
    (key: string): Position => {
      const { scroll, zoom, viewport } = caps();
      const first = scroll.forDocument(key).getMetrics().pageVisibilityMetrics[0];
      const level = zoom.forDocument(key).getState().zoomLevel;
      if (first === undefined) {
        return { pageNumber: 1, x: 0, y: 0, zoom: level };
      }
      const gap = viewport.getViewportGap();
      return {
        pageNumber: first.pageNumber,
        x: first.original.pageX - (first.viewportX + gap) / first.scaled.scale,
        y: first.original.pageY - (first.viewportY + gap) / first.scaled.scale,
        zoom: level,
      };
    },
    [caps],
  );

  // Where KEY is, shown or not. EmbedPDF shows no page of a PDF that is not the active one, so the
  // reader keeps the position of the active PDF at each scroll, read while EmbedPDF still shows it.
  const placeOf = useCallback(
    (key: string): Position => {
      const parked = host.parked.get(key);
      return caps().documents.getActiveDocumentId() === key || parked === undefined
        ? positionOf(key)
        : parked;
    },
    [host, caps, positionOf],
  );

  // Moves KEY to POSITION; the move records no jump.
  const restore = useCallback(
    (key: string, position: Position) => {
      const { scroll, zoom } = caps();
      const scope = zoom.forDocument(key);
      if (scope.getState().zoomLevel !== position.zoom) {
        scope.requestZoom(position.zoom);
      }
      host.moving = true;
      try {
        scroll.forDocument(key).scrollToPage({
          pageNumber: position.pageNumber,
          pageCoordinates: { x: position.x, y: position.y },
          behavior: "instant",
        });
      } finally {
        host.moving = false;
      }
    },
    [caps, host],
  );

  // EmbedPDF's zoom plugin gates a PDF's viewport until its first zoom, which waits for the
  // viewport to have a size; a zoom asked for before then is dropped.
  const restoreOnceSized = useCallback(
    (key: string, position: Position) => {
      const { viewport } = caps();
      if (!viewport.isGated(key)) {
        restore(key, position);
        return;
      }
      const stop = viewport.onGateChange((event) => {
        if (event.documentId === key && !event.isGated) {
          stop();
          restore(key, position);
        }
      });
    },
    [caps, restore],
  );

  // Scrolls KEY's PDF to the top of PAGE, a move of the reader's own that records no jump.
  const scrollToStart = useCallback(
    (key: string, page: number) => {
      host.moving = true;
      try {
        caps().scroll.forDocument(key).scrollToPage({ pageNumber: page, behavior: "instant" });
      } finally {
        host.moving = false;
      }
    },
    [caps, host],
  );

  return { positionOf, placeOf, restore, restoreOnceSized, scrollToStart };
}
