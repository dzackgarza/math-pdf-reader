// The bucket's event stream (`GET /api/events`, server/src/events.rs), one per window, shared by
// every listener: each stream holds an HTTP/1.1 connection open, and a browser keeps at most six
// to one origin, so a second stream per window leaves too few connections for the PDFs and API calls.
// A state event (`index-export`, `zotero`) comes once per connection and then at each change, so
// a listener that joins the shared stream later is handed the latest one first, as RxJS's
// BehaviorSubject hands its current value to a new subscriber.
// A page the browser keeps in its back/forward cache would keep its stream's connection, and a
// few such pages take all six: the stream closes when the page is hidden and opens again when a
// cached page is shown, as https://web.dev/articles/bfcache advises for open connections.
const STATE_EVENTS = ["index-export", "zotero"];

type Listener = (event: MessageEvent<string>) => void;

let stream: EventSource | null = null;
const listeners = new Map<string, Set<Listener>>();
const latest = new Map<string, MessageEvent<string>>();

function open(): void {
  const opened = new EventSource("/api/events");
  for (const type of STATE_EVENTS) {
    opened.addEventListener(type, (event: MessageEvent<string>) => latest.set(type, event));
  }
  for (const [type, set] of listeners) {
    for (const listener of set) {
      opened.addEventListener(type, listener);
    }
  }
  stream = opened;
}

function close(): void {
  stream?.close();
  stream = null;
  latest.clear();
}

window.addEventListener("pagehide", close);
window.addEventListener("pageshow", (event) => {
  if (event.persisted && listeners.size > 0) {
    open();
  }
});

// Calls LISTENER with every event of TYPE, a state event's latest one first; the answer stops it.
export function onBucketEvent(type: string, listener: Listener): () => void {
  const set = listeners.get(type) ?? new Set();
  listeners.set(type, set);
  set.add(listener);
  if (stream === null) {
    open();
  } else {
    stream.addEventListener(type, listener);
    const current = latest.get(type);
    if (current !== undefined) {
      listener(current);
    }
  }
  return () => {
    set.delete(listener);
    stream?.removeEventListener(type, listener);
    if (set.size === 0) {
      listeners.delete(type);
    }
    if (listeners.size === 0) {
      close();
    }
  };
}
