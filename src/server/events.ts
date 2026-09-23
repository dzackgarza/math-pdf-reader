// Server-sent events for the desktop window: after every capture, new or existing, the
// window moves to the item's reader page (desktop/src-tauri follows `open-reader`).
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";

export type OpenReaderEvent = { reader_url: string };

// Bun closes a connection that stays idle for 10 s; a comment line between events keeps
// the stream open so no event falls into a reconnect gap.
const KEEPALIVE_INTERVAL_MS = 5_000;

export class BucketEvents {
  private readonly subscribers = new Set<(event: OpenReaderEvent) => void>();

  publishOpenReader(event: OpenReaderEvent): void {
    for (const send of this.subscribers) {
      send(event);
    }
  }

  stream(c: Context): Response {
    return streamSSE(c, async (stream) => {
      const send = (event: OpenReaderEvent) => {
        void stream.writeSSE({ event: "open-reader", data: JSON.stringify(event) });
      };
      this.subscribers.add(send);
      stream.onAbort(() => {
        this.subscribers.delete(send);
      });
      while (!stream.aborted) {
        await stream.sleep(KEEPALIVE_INTERVAL_MS);
        await stream.write(": keepalive\n\n");
      }
    });
  }
}
