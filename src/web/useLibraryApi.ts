// The library UI's connection to the bucket server: loads `/api/library`, applies filing
// mutations, and keeps the payload current after each one.
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import {
  type ApiErrorKind,
  ApiErrorSchema,
  type LibraryPayload,
  LibraryPayloadSchema,
} from "../server/libraryContract";

export type LibraryState =
  | { status: "loading" }
  | { status: "ready"; payload: LibraryPayload }
  | { status: "failed"; message: string; detail: string | null };

// A store failure (for example a PDF under the root without embedded provenance).
const StoreFailureSchema = z.strictObject({
  error: z.literal("store_command_failed"),
  exit_code: z.number(),
  stderr: z.string(),
});

const FailureSchema = z.union([ApiErrorSchema, StoreFailureSchema]);

// A refusal from the bucket server: what went wrong, and the store's full output when the
// store command itself failed.
export class BucketRequestError extends Error {
  constructor(
    readonly kind: ApiErrorKind | "store_command_failed",
    message: string,
    readonly detail: string | null,
  ) {
    super(message);
  }
}

async function requestError(response: Response): Promise<BucketRequestError> {
  const failure = FailureSchema.parse(await response.json());
  if (failure.error !== "store_command_failed") {
    return new BucketRequestError(failure.error.kind, failure.error.message, null);
  }
  // The store's last line names the failure (for example the PDF that has no provenance).
  const lines = failure.stderr.trim().split("\n");
  return new BucketRequestError(
    failure.error,
    `${lines[lines.length - 1]} (exit ${failure.exit_code})`,
    failure.stderr,
  );
}

async function requestJson(method: string, path: string, body?: object): Promise<unknown> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw await requestError(response);
  }
  return response.json();
}

async function fetchLibrary(): Promise<LibraryPayload> {
  return LibraryPayloadSchema.parse(await requestJson("GET", "/api/library"));
}

export type Mutate = <T extends z.ZodType>(
  schema: T,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: object,
) => Promise<z.infer<T>>;

// The library calls the window makes once the library has loaded.
export type LibraryApi = { reload: () => void; refresh: () => void; mutate: Mutate };

export function useLibraryApi() {
  const [state, setState] = useState<LibraryState>({ status: "loading" });

  const show = useCallback((load: Promise<LibraryPayload>) => {
    load.then(
      (payload) => setState({ status: "ready", payload }),
      (error: Error) =>
        setState({
          status: "failed",
          message: error.message,
          detail: error instanceof BucketRequestError ? error.detail : null,
        }),
    );
  }, []);

  const reload = useCallback(() => {
    setState({ status: "loading" });
    show(fetchLibrary());
  }, [show]);

  // The first load starts from the initial loading state; later reloads pass through it again.
  useEffect(() => show(fetchLibrary()), [show]);

  // Every mutation answers with the full payload or with the created entity; either way the
  // table shows the stored state afterwards, without passing through the loading screen.
  const mutate: Mutate = useCallback(
    async (schema, method, path, body) => {
      const json = await requestJson(method, path, body);
      const payload = LibraryPayloadSchema.safeParse(json);
      show(payload.success ? Promise.resolve(payload.data) : fetchLibrary());
      return schema.parse(json);
    },
    [show],
  );

  // Reads the library again without passing through the loading screen.
  const refresh = useCallback(() => show(fetchLibrary()), [show]);

  return { state, reload, refresh, mutate };
}
