// What the extension knows about the bucket and about its own capture switch, shared by the
// background (toolbar badge) and the status page (popup and options page).
import { browser } from "wxt/browser";
import { storage } from "wxt/utils/storage";
import { type ServerStatus, ServerStatusSchema } from "../contract/capture";
import { ApiErrorSchema } from "../contract/library";
import type { CaptureOutcome } from "./messages";

// Whether this browser's PDF navigations go to the bucket. On until the user switches it off.
export const captureEnabled = storage.defineItem<boolean>("local:captureEnabled", {
  init: () => true,
});

export type LastCapture = { pdf_url: string; at: number; outcome: CaptureOutcome };

// The most recent capture attempt from this browser; null until the first one.
export const lastCapture = storage.defineItem<LastCapture | null>("local:lastCapture", {
  fallback: null,
});

export type BucketState =
  | { kind: "ready"; status: ServerStatus }
  | { kind: "not-ready"; status: ServerStatus }
  | { kind: "check-failed"; detail: string }
  | { kind: "unreachable"; detail: string };

// A refused connection or a non-bucket answer on the configured port is `unreachable`: the
// extension cannot hand PDFs to it. The bucket's own error document is `check-failed`: it
// answered, but could not tell whether its data folder can take captures.
export async function checkBucket(bucketOrigin: string): Promise<BucketState> {
  const answered = await fetch(`${bucketOrigin}/status`, { cache: "no-store" }).then(
    (response) => ({ ok: true as const, response }),
    (error: unknown) => ({ ok: false as const, detail: String(error) }),
  );
  if (!answered.ok) {
    return { kind: "unreachable", detail: answered.detail };
  }
  if (!answered.response.ok) {
    const detail = `${answered.response.status} ${answered.response.statusText}`;
    if (answered.response.headers.get("Content-Type") !== "application/json") {
      return { kind: "unreachable", detail };
    }
    const failure = ApiErrorSchema.safeParse(await answered.response.json());
    return failure.success
      ? { kind: "check-failed", detail: failure.data.error.message }
      : { kind: "unreachable", detail };
  }
  const status = ServerStatusSchema.safeParse(await answered.response.json());
  if (!status.success) {
    return { kind: "unreachable", detail: `not a PDF Bucket status report: ${status.error}` };
  }
  return { kind: status.data.ready ? "ready" : "not-ready", status: status.data };
}

type Badge = { text: string; color: string; title: string };

function badgeFor(state: BucketState, enabled: boolean, bucketOrigin: string): Badge {
  if (state.kind === "unreachable") {
    return { text: "!", color: "#b3261e", title: `PDF Bucket is not reachable at ${bucketOrigin}` };
  }
  if (state.kind === "check-failed") {
    return {
      text: "!",
      color: "#b3261e",
      title: `PDF Bucket at ${bucketOrigin} cannot tell whether it can store PDFs (${state.detail})`,
    };
  }
  if (state.kind === "not-ready") {
    const cause = state.status.storage.root_exists ? "is not writable" : "does not exist";
    return {
      text: "!",
      color: "#b3261e",
      title: `PDF Bucket at ${bucketOrigin} cannot store PDFs (${state.status.root} ${cause})`,
    };
  }
  if (!enabled) {
    return { text: "OFF", color: "#5f6368", title: "PDF Bucket: capture is off in this browser" };
  }
  return { text: "ON", color: "#1e7a3c", title: "PDF Bucket: PDF links open in the bucket" };
}

// Chrome (MV3) names the toolbar button `action`, Firefox (MV2) `browserAction`.
function toolbarButton() {
  return import.meta.env.FIREFOX ? browser.browserAction : browser.action;
}

export async function showOnToolbar(
  state: BucketState,
  enabled: boolean,
  bucketOrigin: string,
): Promise<void> {
  const badge = badgeFor(state, enabled, bucketOrigin);
  const button = toolbarButton();
  await Promise.all([
    button.setBadgeText({ text: badge.text }),
    button.setBadgeBackgroundColor({ color: badge.color }),
    button.setTitle({ title: badge.title }),
  ]);
}

export async function refreshToolbar(bucketOrigin: string): Promise<BucketState> {
  const [state, enabled] = await Promise.all([
    checkBucket(bucketOrigin),
    captureEnabled.getValue(),
  ]);
  await showOnToolbar(state, enabled, bucketOrigin);
  return state;
}
