// The bucket under test: the app's server, run headless by `pdf-bucket serve` over a bucket
// root on a free port, one process per bucket, stopped when the test process exits. Requests go
// over real HTTP to the origin it prints.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppConfig, CONFIG_PATH, REPO_ROOT } from "../src/contract/config";

// Built once per test run by tests/preload.ts.
export const SERVER_BINARY = join(REPO_ROOT, "target/debug/pdf-bucket");
export const EXTRACTIONS_MANIFEST = join(REPO_ROOT, "plugins/manifests/extractions.json");
export const RESOLVERS_MANIFEST = join(REPO_ROOT, "plugins/manifests/resolvers.json");

export type BucketOptions = {
  root: string;
  // Zotero's local HTTP server.
  zoteroUrl: string;
  extractionsManifest: string;
  resolversManifest: string;
  // The index export the server rewrites after every change; a test that does not read it gets
  // one in a scratch directory of its own.
  indexExport?: string;
  // The app config the server runs with; a test that does not shorten its time limits runs
  // with the checkout's pdf-bucket.config.json.
  config?: AppConfig;
};

export type Bucket = {
  origin: string;
  indexExport: string;
  // PATH is a path on the bucket's origin, such as `/api/library`.
  request(path: string, init?: RequestInit): Promise<Response>;
  stop(): Promise<void>;
};

function configPath(config: AppConfig | undefined): string {
  if (config === undefined) {
    return CONFIG_PATH;
  }
  const path = join(mkdtempSync(join(tmpdir(), "pdf-bucket-config-")), "pdf-bucket.config.json");
  writeFileSync(path, JSON.stringify(config));
  return path;
}

export async function serveBucket(options: BucketOptions): Promise<Bucket> {
  const indexExport =
    options.indexExport ?? join(mkdtempSync(join(tmpdir(), "pdf-bucket-export-")), "index.json");
  const configFile = configPath(options.config);
  const command = [
    SERVER_BINARY,
    "serve",
    options.root,
    options.zoteroUrl,
    options.extractionsManifest,
    options.resolversManifest,
    "--index-export",
    indexExport,
    "--config",
    configFile,
  ];
  // Bun.spawn without `env` passes the environment the test process started with; the
  // preload's scratch XDG directories are in process.env now.
  // The server serves until its standard input closes: when this process ends, so does it.
  const server = Bun.spawn(command, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: process.env,
  });
  const reader = server.stdout.getReader();
  let printed = "";
  while (!printed.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) {
      throw new Error(`pdf-bucket serve exited before printing its origin: ${command.join(" ")}`);
    }
    printed += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const origin = printed.trim();
  return {
    origin,
    indexExport,
    request: (path, init) => fetch(new URL(path, origin), init),
    stop: async () => {
      server.kill();
      await server.exited;
    },
  };
}
