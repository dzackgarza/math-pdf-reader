import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { z } from "zod";
import { type AppConfig, CONFIG_PATH, REPO_ROOT } from "../src/contract/config";

export const SERVER_BINARY = join(REPO_ROOT, "target/debug/pdf-bucket");
export const EXTRACTIONS_MANIFEST = join(
  REPO_ROOT,
  "plugins/manifests/extractions.json",
);

export type BucketOptions = {
  root: string;
  zoteroUrl: string;
  extractionsManifest: string;
  indexExport?: string;
  config?: AppConfig;
  extensions?: string;
  appBuild?: string;
  checkout?: string;
  env?: Record<string, string>;
};

export type Bucket = {
  origin: string;
  indexExport: string;
  temporaryPaths: string[];
  request(path: string, init?: RequestInit): Promise<Response>;
  stop(): Promise<void>;
};

function configPath(config: AppConfig | undefined): string {
  if (config === undefined) {
    return CONFIG_PATH;
  }
  const path = join(
    mkdtempSync(join(tmpdir(), "pdf-bucket-config-")),
    "pdf-bucket.config.json",
  );
  writeFileSync(path, JSON.stringify(config));
  return path;
}

export async function serveBucket(options: BucketOptions): Promise<Bucket> {
  const indexExport =
    options.indexExport ??
    join(mkdtempSync(join(tmpdir(), "pdf-bucket-export-")), "index.json");
  const configFile = configPath(options.config);
  const extensions =
    options.extensions ?? mkdtempSync(join(tmpdir(), "pdf-bucket-extensions-"));
  const appBuild =
    options.appBuild ?? mkdtempSync(join(tmpdir(), "pdf-bucket-app-build-"));
  const temporaryPaths = [
    ...(options.config === undefined ? [] : [dirname(configFile)]),
    ...(options.extensions === undefined ? [extensions] : []),
    ...(options.appBuild === undefined ? [appBuild] : []),
  ];
  if (options.indexExport === undefined)
    temporaryPaths.push(dirname(indexExport));
  const command = [
    SERVER_BINARY,
    "serve",
    options.root,
    options.zoteroUrl,
    options.extractionsManifest,
    "--index-export",
    indexExport,
    "--config",
    configFile,
    "--extensions",
    extensions,
    "--app-build",
    appBuild,
    "--checkout",
    options.checkout ?? REPO_ROOT,
  ];
  const server = Bun.spawn(command, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, ...options.env },
  });
  const reader = server.stdout.getReader();
  let printed = "";
  while (!printed.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) {
      throw new Error(
        `pdf-bucket serve exited before printing its origin: ${command.join(" ")}`,
      );
    }
    printed += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const origin = printed.trim();
  return {
    origin,
    indexExport,
    temporaryPaths,
    request: (path, init) => fetch(new URL(path, origin), init),
    stop: async () => {
      server.kill();
      await server.exited;
    },
  };
}

export function closedPortUrl(): string {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const url = server.url.origin;
  server.stop(true);
  return url;
}

export async function subscribeEvents(app: Bucket) {
  const response = await app.request("/api/events");
  if (response.body === null) {
    throw new Error("the event stream response has no body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const received: { name: string; data: string }[] = [];
  let buffered = "";
  return {
    async next<T>(name: string, schema: z.ZodType<T>): Promise<T> {
      for (;;) {
        const index = received.findIndex((event) => event.name === name);
        if (index !== -1) {
          const [event] = received.splice(index, 1);
          return schema.parse(JSON.parse(event.data));
        }
        const chunk = await reader.read();
        if (chunk.done) {
          throw new Error(`the event stream ended before a ${name} event`);
        }
        buffered += decoder.decode(chunk.value, { stream: true });
        const blocks = buffered.split("\n\n");
        buffered = blocks.pop() ?? "";
        for (const block of blocks) {
          const fields = new Map(
            block.split("\n").map((line) => {
              const colon = line.indexOf(":");
              return [
                line.slice(0, colon),
                line.slice(colon + 1).trimStart(),
              ] as const;
            }),
          );
          const event = fields.get("event");
          const data = fields.get("data");
          if (event !== undefined && data !== undefined) {
            received.push({ name: event, data });
          }
        }
      }
    },
    close: () => reader.cancel(),
  };
}
