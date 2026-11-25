import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../src/contract/config";

test("a test run leaves nothing in the temporary directory it was given", () => {
  const given = mkdtempSync(join(tmpdir(), "pdf-bucket-given-tmp-"));
  const run = Bun.spawnSync(["bun", "test", "tests/server-events.test.ts"], {
    cwd: REPO_ROOT,
    env: { ...process.env, TMPDIR: given },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.exitCode).toBe(0);
  expect(readdirSync(given)).toEqual([]);
}, 300_000);
