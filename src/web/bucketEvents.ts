// The bucket's event stream (`GET /api/events`, server/src/events.rs), one per window, shared by
// every listener: each stream holds an HTTP/1.1 connection open, and a browser keeps at most six
// to one origin, so a second stream per window leaves the reader frames too few to load.
let stream: EventSource | null = null;
let listening = 0;

// Calls LISTENER with every event of TYPE; the answer stops it.
export function onBucketEvent(
  type: string,
  listener: (event: MessageEvent<string>) => void,
): () => void {
  if (stream === null) {
    stream = new EventSource("/api/events");
  }
  const shared = stream;
  listening += 1;
  shared.addEventListener(type, listener);
  return () => {
    shared.removeEventListener(type, listener);
    listening -= 1;
    if (listening === 0) {
      shared.close();
      stream = null;
    }
  };
}
