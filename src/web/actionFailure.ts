import type { ApiErrorKind } from "../contract/library";
import { BucketRequestError, BucketUnreachableError } from "./useLibraryApi";

export type ActionFailure =
  | { source: "bucket"; status: number; kind: ApiErrorKind | null; message: string }
  | { source: "unreachable"; message: string }
  | { source: "desktop"; message: string }
  | { source: "browser"; name: string; message: string }
  | { source: "defect"; name: string; message: string };

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

export function describeFailure(failure: ActionFailure): { title: string; detail: string } {
  switch (failure.source) {
    case "bucket":
      return failure.kind === null
        ? { title: `Math PDF Reader answered HTTP ${failure.status}`, detail: failure.message }
        : { title: "Math PDF Reader refused", detail: `${failure.message} (${failure.kind})` };
    case "unreachable":
      return { title: "Math PDF Reader did not answer", detail: failure.message };
    case "desktop":
      return { title: "The desktop could not do it", detail: failure.message };
    case "browser":
      return { title: "The browser refused", detail: `${failure.name}: ${failure.message}` };
    case "defect":
      return { title: "The window failed", detail: `${failure.name}: ${failure.message}` };
  }
}
