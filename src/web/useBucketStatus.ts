import { useEffect, useState } from "react";
import { type ServerStatus, ServerStatusSchema } from "../contract/capture";
import { type AppBuild, AppBuildSchema, type Settings, SettingsSchema } from "../contract/library";
import { request } from "./useLibraryApi";

export type BucketStatus = ServerStatus & { settings: Settings; appBuild: AppBuild; checkedAt: Date };

export type StatusRead =
  | { kind: "checking" }
  | { kind: "read"; status: BucketStatus }
  | { kind: "failed"; message: string };

async function readStatus(): Promise<BucketStatus> {
  const [status, settings, appBuild] = await Promise.all([
    request(ServerStatusSchema, "GET", "/status"),
    request(SettingsSchema, "GET", "/api/settings"),
    request(AppBuildSchema, "GET", "/api/app-build"),
  ]);
  return { ...status, settings, appBuild, checkedAt: new Date() };
}

export function useBucketStatus(): StatusRead {
  const [read, setRead] = useState<StatusRead>({ kind: "checking" });
  useEffect(() => {
    const reread = () =>
      readStatus().then(
        (status) => setRead({ kind: "read", status }),
        (error: Error) => setRead({ kind: "failed", message: error.message }),
      );
    void reread();
    window.addEventListener("focus", reread);
    return () => window.removeEventListener("focus", reread);
  }, []);
  return read;
}
