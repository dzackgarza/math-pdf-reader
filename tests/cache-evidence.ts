// The docs/m5.md evidence for the index export and the cache rebuild, run through the real
// `just` recipes on a temporary XDG data home: `bun tests/cache-evidence.ts`. An in-process
// publisher serves committed fixture PDFs over HTTP; nothing touches the configured bucket,
// its port, or the internet.

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { CaptureResponseSchema } from "../src/contract/capture";
import { CONFIG_PATH, loadAppConfig, REPO_ROOT } from "../src/contract/config";
import { CollectionSchema } from "../src/contract/library";
import { EXTRACTIONS_MANIFEST, RESOLVERS_MANIFEST, serveBucket } from "./bucket";

const fixtures = join(import.meta.dir, "fixtures");
const papers: Record<string, string> = {
  "/notes/lecture-notes.pdf": "lecture-notes.pdf",
  "/pdf/2401.00001": "problem-set.pdf",
  "/teaching/ten-page-notes.pdf": "ten-page-notes.pdf",
  "/papers/long-notes.pdf": "long-notes.pdf",
};
const online = new Set(Object.keys(papers));
const publisher = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    const name = papers[path];
    if (name === undefined || !online.has(path)) {
      return new Response("not found", { status: 404 });
    }
    return new Response(Bun.file(join(fixtures, name)), {
      headers: { "Content-Type": "application/pdf" },
    });
  },
});
const at = (path: string) => new URL(path, publisher.url).href;

const xdg = mkdtempSync(join(tmpdir(), "pdf-bucket-m5-evidence-"));
const root = join(xdg, "pdf-bucket");
const exportFile = join(xdg, "pdf-bucket-export", "index.json");
mkdirSync(root);
const env = { ...process.env, XDG_DATA_HOME: xdg };
const config = loadAppConfig(CONFIG_PATH);
const app = await serveBucket({
  root,
  zoteroUrl: config.zotero.url,
  extractionsManifest: EXTRACTIONS_MANIFEST,
  resolversManifest: RESOLVERS_MANIFEST,
});
const api = app.request;

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Print a command and its output; answer its exit code.
async function run(command: string): Promise<number> {
  process.stdout.write(`$ ${command}\n`);
  const result = await $`bash -c ${command}`.cwd(REPO_ROOT).env(env).nothrow().quiet();
  process.stdout.write(`${result.stdout}${result.stderr}(exit ${result.exitCode})\n\n`);
  return result.exitCode;
}

process.stdout.write(`XDG_DATA_HOME=${xdg}\npublisher ${publisher.url.origin}\n\n`);

for (const [path, name] of Object.entries(papers)) {
  const form = new FormData();
  const filename = path === "/pdf/2401.00001" ? "2401.00001" : name;
  form.set("pdf", new File([readFileSync(join(fixtures, name))], filename));
  form.set("pdf_url", at(path));
  form.set("source_url", at("/teaching.html"));
  form.set("title_hint", `Notes: ${name}`);
  const captured = CaptureResponseSchema.parse(
    await (await api("/capture-bytes", { method: "POST", body: form })).json(),
  );
  process.stdout.write(`captured ${captured.key} from ${captured.provenance.pdf_url}\n`);
}
const forms = CollectionSchema.parse(
  await (
    await api("/api/collections", {
      method: "POST",
      body: JSON.stringify({ name: "Quadratic forms" }),
      headers: { "Content-Type": "application/json" },
    })
  ).json(),
);
for (const [key, tags] of [
  ["lecture-notes", ["topic:lattices", "to-read"]],
  ["2401.00001", ["topic:packing"]],
] as const) {
  await api("/api/bulk/tags", {
    method: "POST",
    body: JSON.stringify({ keys: [key], add: tags, remove: [] }),
    headers: { "Content-Type": "application/json" },
  });
  await api("/api/bulk/collections", {
    method: "POST",
    body: JSON.stringify({ keys: [key], add: [forms.id], remove: [] }),
    headers: { "Content-Type": "application/json" },
  });
}
process.stdout.write("filed lecture-notes and 2401.00001 into Quadratic forms, with tags\n\n");

process.stdout.write("## Export, wipe, import, rebuild, export again, diff\n\n");
await run("just export-index");
const firstExport = join(xdg, "export-1.json");
const organizationBefore = join(xdg, "organization-before.json");
copyFileSync(exportFile, firstExport);
copyFileSync(join(root, "organization.json"), organizationBefore);
await run(`trash ${root}`);
await run("just import-index");
// Key order inside organization.json follows filing order, so both sides are sorted first.
await run(
  `diff <(jq -S . ${organizationBefore}) <(jq -S . ${root}/organization.json) && echo organization.json identical`,
);
await run("just rebuild-cache");
await run("just export-index");
await run(`diff ${firstExport} ${exportFile} && echo exports identical`);

process.stdout.write("## Delete three PDFs, one of them now at a dead URL; rebuild\n\n");
online.delete("/papers/long-notes.pdf");
process.stdout.write(`the publisher now answers 404 at ${at("/papers/long-notes.pdf")}\n`);
for (const key of ["lecture-notes", "2401.00001", "long-notes"]) {
  unlinkSync(join(root, `${key}.pdf`));
  process.stdout.write(`deleted ${key}.pdf\n`);
}
process.stdout.write("\n");
await run("just rebuild-cache");
await run(`ls ${root}`);

process.stdout.write(
  "## Recorded original hash of each stored PDF against the fixture it came from\n\n",
);
for (const [path, name] of Object.entries(papers)) {
  const key = path === "/pdf/2401.00001" ? "2401.00001" : name.slice(0, -".pdf".length);
  if (!existsSync(join(root, `${key}.pdf`))) {
    process.stdout.write(`${key}: no stored PDF\n\n`);
    continue;
  }
  await run(
    `printf '%s ' ${key} && uv run --locked pdfbucket read -- ${join(root, `${key}.pdf`)} | jq -r '.[0].record.provenance.original_sha256'`,
  );
  process.stdout.write(`fixture ${name} ${sha256(join(fixtures, name))}\n\n`);
}
publisher.stop(true);
await app.stop();
