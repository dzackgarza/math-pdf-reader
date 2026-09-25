// The library UI's connection to the bucket server: loads `/api/library`, applies filing
// changes, and keeps the payload current.
//
// Every request answered with the whole library runs in one queue (async-mutex), so the window
// applies answers in the order the server wrote them: an answer that arrives late cannot put an
// older library back. Calls answered with something else (a send, an import, a rebuild) run
// outside the queue, and the library is read again, in the queue, once they end. The library is
// also read again when the window gains focus and when the bucket reports a write (a new state of
// the index export, which follows every filing write and every capture, on /api/events).
import { Mutex } from "async-mutex";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { z } from "zod";
import { IndexExportStateSchema } from "../contract/capture";
import {
  type ApiErrorKind,
  ApiErrorSchema,
  type LibraryPayload,
  LibraryPayloadSchema,
} from "../contract/library";
import { onBucketEvent } from "./bucketEvents";

export type LibraryState =
  | { status: "loading" }
  // `readFailure`: a read after the first one failed; the window keeps the library it has.
  | { status: "ready"; payload: LibraryPayload; readFailure: string | null }
  | { status: "failed"; message: string };

// A refusal from the bucket server: the HTTP status, and the kind and message of the bucket's
// error document. A body that is not the error document (a proxy, a crashed server) has no
// kind; the status and its text are the message.
export class BucketRequestError extends Error {
  constructor(
    readonly status: number,
    readonly kind: ApiErrorKind | null,
    message: string,
  ) {
    super(message);
  }
}

export async function requestError(response: Response): Promise<BucketRequestError> {
  const text = await response.text();
  const type = response.headers.get("Content-Type");
  if (type !== null && type.startsWith("application/json")) {
    const { error } = ApiErrorSchema.parse(JSON.parse(text));
    return new BucketRequestError(response.status, error.kind, error.message);
  }
  const detail = text.trim() === "" ? response.statusText : text.trim();
  return new BucketRequestError(response.status, null, `HTTP ${response.status}: ${detail}`);
}

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// One request to the bucket, its answer parsed with SCHEMA.
export async function request<T extends z.ZodType>(
  schema: T,
  method: Method,
  path: string,
  body?: object,
): Promise<z.infer<T>> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw await requestError(response);
  }
  return schema.parse(await response.json());
}

// The library calls the window makes once the library has loaded.
export type LibraryApi = {
  // A filing change the server answers with the whole library, which the window then shows.
  change: (method: Exclude<Method, "GET">, path: string, body?: object) => Promise<LibraryPayload>;
  // Any other call; the library is read again when it ends, whether or not it succeeded, since
  // a failed call may have changed the library part way.
  call: <T extends z.ZodType>(
    schema: T,
    method: Exclude<Method, "GET">,
    path: string,
    body?: object,
  ) => Promise<z.infer<T>>;
  // Reads the library again; the window keeps showing the library it has meanwhile.
  refresh: () => void;
};

export function useLibraryApi() {
  const [state, setState] = useState<LibraryState>({ status: "loading" });
  const queue = useRef(new Mutex());
  // A read waiting in the queue already reads everything written before it starts.
  const readWaiting = useRef(false);

  // Runs SEND in the queue and shows the library it answers.
  const inQueue = useCallback(
    (send: () => Promise<LibraryPayload>) =>
      queue.current.runExclusive(async () => {
        const payload = await send();
        setState({ status: "ready", payload, readFailure: null });
        return payload;
      }),
    [],
  );

  // A failed read leaves a shown library in place, marked stale; before the first library it
  // fails the window.
  const refresh = useCallback(() => {
    if (readWaiting.current) {
      return;
    }
    readWaiting.current = true;
    inQueue(() => {
      readWaiting.current = false;
      return request(LibraryPayloadSchema, "GET", "/api/library");
    }).then(
      () => undefined,
      (error: Error) =>
        setState((previous) =>
          previous.status === "ready"
            ? { ...previous, readFailure: error.message }
            : { status: "failed", message: error.message },
        ),
    );
  }, [inQueue]);

  // A new try after the first read failed.
  const reload = useCallback(() => {
    setState({ status: "loading" });
    refresh();
  }, [refresh]);

  useEffect(refresh, [refresh]);

  useEffect(() => {
    window.addEventListener("focus", refresh);
    const stopEvents = onBucketEvent("index-export", (event) => {
      if (IndexExportStateSchema.parse(JSON.parse(event.data)).status !== "pending") {
        refresh();
      }
    });
    return () => {
      window.removeEventListener("focus", refresh);
      stopEvents();
    };
  }, [refresh]);

  const change: LibraryApi["change"] = useCallback(
    (method, path, body) =>
      inQueue(() => request(LibraryPayloadSchema, method, path, body)).catch((error: Error) => {
        refresh();
        throw error;
      }),
    [inQueue, refresh],
  );

  const call: LibraryApi["call"] = useCallback(
    (schema, method, path, body) => request(schema, method, path, body).finally(refresh),
    [refresh],
  );

  const api: LibraryApi = useMemo(() => ({ change, call, refresh }), [change, call, refresh]);
  return { state, reload, api };
}
