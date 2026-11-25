import { afterAll } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../src/contract/config";

const systemTmp = tmpdir();
const runPrefix = "pdf-bucket-test-run-";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

for (const entry of readdirSync(systemTmp)) {
  if (!entry.startsWith(runPrefix)) continue;
  const pid = Number(entry.slice(runPrefix.length).split("-")[0]);
  if (!alive(pid)) rmSync(join(systemTmp, entry), { recursive: true, force: true });
}

const run = mkdtempSync(join(systemTmp, `${runPrefix}${process.pid}-`));
process.env.TMPDIR = run;
export const SCREENSHOT_ROOT = systemTmp;
export const SCRATCH_DATA_HOME = mkdtempSync(join(run, "data-"));
process.env.XDG_DATA_HOME = SCRATCH_DATA_HOME;
process.env.XDG_CACHE_HOME = mkdtempSync(join(run, "cache-"));

afterAll(() => {
  rmSync(run, { recursive: true, force: true });
});

const synced = Bun.spawnSync(["uv", "sync", "--locked", "--quiet"], {
  cwd: REPO_ROOT,
  env: process.env,
  stdout: "inherit",
  stderr: "inherit",
});
if (synced.exitCode !== 0) {
  throw new Error(`uv could not sync the checkout's Python environment (exit ${synced.exitCode})`);
}

const built = Bun.spawnSync(
  ["cargo", "build", "--quiet", "--package", "pdf-bucket", "--bin", "pdf-bucket", "--features", "arxiv-fixtures"],
  {
    cwd: REPO_ROOT,
    env: process.env,
    stdout: "inherit",
    stderr: "inherit",
  },
);
if (built.exitCode !== 0) {
  throw new Error(`cargo could not build the pdf-bucket server (exit ${built.exitCode})`);
}
