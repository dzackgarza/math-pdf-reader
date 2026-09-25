// Why an action the window started failed, kept by what refused it: the bucket server with its
// error kind, the bucket not answering, a desktop plugin, the browser, or the window's own code.
import type { ApiErrorKind } from "../contract/library";
import { BucketRequestError, BucketUnreachableError } from "./useLibraryApi";

export type ActionFailure =
  // `kind` is null when the answer is not the bucket's error document (a proxy, a crash).
  | { source: "bucket"; status: number; kind: ApiErrorKind | null; message: string }
  | { source: "unreachable"; message: string }
  // Tauri's opener and dialog plugins.
  | { source: "desktop"; message: string }
  // A browser API that refused, such as the clipboard; `name` is the DOMException's name.
  | { source: "browser"; name: string; message: string }
  // An error the window threw itself, such as an answer that does not parse: a defect.
  | { source: "defect"; name: string; message: string };

// What an action's promise rejects with. A Tauri plugin rejects with its error serialized to a
// string (tauri-plugin-opener and -dialog serialize their `Error` with `serialize_str`).
export type ActionRejection =
  | BucketRequestError
  | BucketUnreachableError
  | DOMException
  | Error
  | string;

export function actionFailure(rejection: ActionRejection): ActionFailure {
  if (typeof rejection === "string") {
    return { source: "desktop", message: rejection };
  }
  if (rejection instanceof BucketRequestError) {
    const { status, kind, message } = rejection;
    return { source: "bucket", status, kind, message };
  }
  if (rejection instanceof BucketUnreachableError) {
    return { source: "unreachable", message: rejection.message };
  }
  if (rejection instanceof DOMException) {
    return { source: "browser", name: rejection.name, message: rejection.message };
  }
  return { source: "defect", name: rejection.name, message: rejection.message };
}

// The heading and the detail the window shows for a failure.
export function describeFailure(failure: ActionFailure): { title: string; detail: string } {
  switch (failure.source) {
    case "bucket":
      return failure.kind === null
        ? { title: `The bucket answered HTTP ${failure.status}`, detail: failure.message }
        : { title: "The bucket refused", detail: `${failure.message} (${failure.kind})` };
    case "unreachable":
      return { title: "The bucket did not answer", detail: failure.message };
    case "desktop":
      return { title: "The desktop could not do it", detail: failure.message };
    case "browser":
      return { title: "The browser refused", detail: `${failure.name}: ${failure.message}` };
    case "defect":
      return { title: "The window failed", detail: `${failure.name}: ${failure.message}` };
  }
}
