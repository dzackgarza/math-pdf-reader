// Status contract: the capture extension and the desktop window poll this before acting.
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";

export type ServerStatus = {
  backend_url: string;
  root: string;
  service: { name: string; version: string };
  storage: { root_exists: boolean; root_writable: boolean };
  capabilities: { capture: boolean };
  ready: boolean;
};

export const SERVICE_NAME = "pdf-bucket";

// Node exposes no boolean permission query; `access` rejects on denial. This is the
// one boundary that translates that rejection into the status contract's boolean.
async function isWritableDirectory(path: string): Promise<boolean> {
  const info = await stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!info) {
    return false;
  }
  return access(path, constants.W_OK).then(
    () => true,
    () => false,
  );
}

export async function serverStatus(
  root: string,
  backendUrl: string,
  version: string,
): Promise<ServerStatus> {
  const rootExists = await stat(root).then(
    (s) => s.isDirectory(),
    () => false,
  );
  const rootWritable = await isWritableDirectory(root);
  return {
    backend_url: backendUrl,
    root,
    service: { name: SERVICE_NAME, version },
    storage: { root_exists: rootExists, root_writable: rootWritable },
    capabilities: { capture: rootWritable },
    ready: rootWritable,
  };
}
