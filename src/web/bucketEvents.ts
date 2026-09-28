// The bucket's event stream (`GET /api/events`, server/src/events.rs), one per window, shared by
// every listener: each stream holds an HTTP/1.1 connection open, and a browser keeps at most six
// to one origin, so a second stream per window leaves the reader frames too few to load.
// A state event (`index-export`, `zotero`) comes once per connection and then at each change, so
// a listener that joins the shared stream later is handed the latest one first, as RxJS's
// BehaviorSubject hands its current value to a new subscriber.
const STATE_EVENTS = ["index-export", "zotero"];

let stream: EventSource | null = null;
let listening = 0;
const latest = new Map<string, MessageEvent<string>>();

function open(): EventSource {
  const opened = new EventSource("/api/events");
  for (const type of STATE_EVENTS) {
    const keep = (event: MessageEvent<string>) => latest.set(type, event);
    opened.addEventListener(type, keep);
  }
  return opened;
}

// Calls LISTENER with every event of TYPE, a state event's latest one first; the answer stops it.
export function onBucketEvent(
  type: string,
  listener: (event: MessageEvent<string>) => void,
): () => void {
  if (stream === null) {
    stream = open();
  }
  const shared = stream;
  listening += 1;
  shared.addEventListener(type, listener);
  const current = latest.get(type);
  if (current !== undefined) {
    listener(current);
  }
  return () => {
    shared.removeEventListener(type, listener);
    listening -= 1;
    if (listening === 0) {
      shared.close();
      stream = null;
      latest.clear();
    }
  };
}
