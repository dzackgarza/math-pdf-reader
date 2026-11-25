import { useCallback } from "react";
import type { Position } from "./documentStorage";
import type { Capabilities, ReaderHost } from "./readerHost";

export function usePositions(host: ReaderHost, caps: () => Capabilities) {
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

  const placeOf = useCallback(
    (key: string): Position => {
      const parked = host.parked.get(key);
      return caps().documents.getActiveDocumentId() === key || parked === undefined
        ? positionOf(key)
        : parked;
    },
    [host, caps, positionOf],
  );

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
          behavior: "auto",
        });
      } finally {
        host.moving = false;
      }
    },
    [caps, host],
  );

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
