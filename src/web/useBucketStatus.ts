// The bucket's `/status` report, read when the window opens.
import { useEffect, useState } from "react";
import { type ServerStatus, ServerStatusSchema } from "../contract/capture";
import { type Settings, SettingsSchema } from "../contract/library";
import { request } from "./useLibraryApi";

export type BucketStatus = ServerStatus & { settings: Settings; checkedAt: Date };

export type StatusRead =
  | { kind: "checking" }
  | { kind: "read"; status: BucketStatus }
  | { kind: "failed"; message: string };

async function readStatus(): Promise<BucketStatus> {
  const [status, settings] = await Promise.all([
    // A failed storage check arrives as the bucket's error document, whose message carries the
    // operating system's error.
    request(ServerStatusSchema, "GET", "/status"),
    request(SettingsSchema, "GET", "/api/settings"),
  ]);
  return { ...status, settings, checkedAt: new Date() };
}

export function useBucketStatus(): StatusRead {
  const [read, setRead] = useState<StatusRead>({ kind: "checking" });
  useEffect(() => {
    readStatus().then(
      (status) => setRead({ kind: "read", status }),
      (error: Error) => setRead({ kind: "failed", message: error.message }),
    );
  }, []);
  return read;
}
