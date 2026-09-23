// The bucket's `/status` report, read when the window opens.
import { useEffect, useState } from "react";
import { z } from "zod";
import { type Settings, SettingsSchema } from "../server/libraryContract";

// The fields of `/status` the library shows; the capture extension reads the rest.
const StatusSchema = z.object({
  backend_url: z.url(),
  root: z.string(),
  service: z.object({ name: z.string(), version: z.string() }),
  capabilities: z.object({ capture: z.boolean() }),
  ready: z.boolean(),
});

export type BucketStatus = z.infer<typeof StatusSchema> & { settings: Settings; checkedAt: Date };

export type StatusRead =
  | { kind: "checking" }
  | { kind: "read"; status: BucketStatus }
  | { kind: "failed"; message: string };

async function readStatus(): Promise<BucketStatus> {
  const [status, settings] = await Promise.all([
    fetch("/status").then(async (response) => StatusSchema.parse(await response.json())),
    fetch("/api/settings").then(async (response) => SettingsSchema.parse(await response.json())),
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
