import { browser } from "wxt/browser";
import { storage } from "wxt/utils/storage";
import { type ServerStatus, ServerStatusSchema } from "../contract/capture";
import { ApiErrorSchema } from "../contract/library";
import { checkedBody } from "./json";
import type { CaptureOutcome } from "./messages";

export const captureEnabled = storage.defineItem<boolean>("local:captureEnabled", {
  init: () => true,
});

export type LastCapture = { pdf_url: string; at: number; outcome: CaptureOutcome };

export const lastCapture = storage.defineItem<LastCapture | null>("local:lastCapture", {
  fallback: null,
});

const reloadedFor = storage.defineItem<string | null>("local:reloadedFor", { fallback: null });

export const reopenAfterReload = storage.defineItem<string | null>("local:reopenAfterReload", {
  fallback: null,
});

type StaleBuild = { kind: "stale"; own: string; provisioned: string; replacement: string };

export type BucketState =
  | { kind: "ready"; status: ServerStatus }
  | { kind: "not-ready"; status: ServerStatus }
  | StaleBuild
  | { kind: "check-failed"; detail: string }
  | { kind: "unreachable"; detail: string };

export async function checkBucket(bucketOrigin: string): Promise<BucketState> {
  const answered = await fetch(`${bucketOrigin}/status`, { cache: "no-store" }).then(
    (response) => ({ ok: true as const, response }),
    (error: unknown) => ({ ok: false as const, detail: String(error) }),
  );
  if (!answered.ok) {
    return { kind: "unreachable", detail: answered.detail };
  }
  const { response } = answered;
  if (!response.ok) {
    const failure = await checkedBody(response, ApiErrorSchema);
    return failure.ok
      ? { kind: "check-failed", detail: failure.value.error.message }
      : { kind: "unreachable", detail: `${response.status} ${response.statusText}` };
  }
  const status = await checkedBody(response, ServerStatusSchema);
  if (!status.ok) {
    return { kind: "unreachable", detail: `not a Math PDF Reader status report: ${status.detail}` };
  }
  const own = browser.runtime.getManifest().version;
  const provisioned = status.value.extensions[import.meta.env.FIREFOX ? "firefox" : "chrome"];
  if (provisioned !== null && provisioned !== own) {
    return { kind: "stale", own, provisioned, replacement: await replacement(provisioned) };
  }
  return { kind: status.value.ready ? "ready" : "not-ready", status: status.value };
}

async function replacement(provisioned: string): Promise<string> {
  if (import.meta.env.FIREFOX) {
    return "Firefox installs it from Math PDF Reader at its next add-on update check, within a few minutes";
  }
  if ((await reloadedFor.getValue()) === provisioned) {
    return "Chromium loads this extension from another directory; load it unpacked from the installed app's extensions/chrome-mv3";
  }
  return "the extension is reloading";
}

async function reloadStaleBuild(provisioned: string): Promise<void> {
  if (import.meta.env.FIREFOX || (await reloadedFor.getValue()) === provisioned) {
    return;
  }
  await reloadedFor.setValue(provisioned);
  browser.runtime.reload();
}

export function staleDetail(state: StaleBuild): string {
  return `Math PDF Reader was provisioned with version ${state.provisioned} of this extension, which is version ${state.own}; it captures nothing until it is replaced: ${state.replacement}`;
}

type Badge = { text: string; color: string; title: string };

function badgeFor(state: BucketState, enabled: boolean, bucketOrigin: string): Badge {
  if (state.kind === "unreachable") {
    return { text: "!", color: "#b3261e", title: `Math PDF Reader is not reachable at ${bucketOrigin}` };
  }
  if (state.kind === "check-failed") {
    return {
      text: "!",
      color: "#b3261e",
      title: `Math PDF Reader at ${bucketOrigin} cannot tell whether it can store PDFs (${state.detail})`,
    };
  }
  if (state.kind === "not-ready") {
    const cause = state.status.storage.root_exists ? "is not writable" : "does not exist";
    return {
      text: "!",
      color: "#b3261e",
      title: `Math PDF Reader at ${bucketOrigin} cannot store PDFs (${state.status.root} ${cause})`,
    };
  }
  if (state.kind === "stale") {
    return { text: "OLD", color: "#b3261e", title: staleDetail(state) };
  }
  if (!enabled) {
    return { text: "OFF", color: "#5f6368", title: "Math PDF Reader: capture is off in this browser" };
  }
  return { text: "ON", color: "#1e7a3c", title: "Math PDF Reader: PDF links open in the app" };
}

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
  if (state.kind === "stale") {
    await reloadStaleBuild(state.provisioned);
  }
  return state;
}
