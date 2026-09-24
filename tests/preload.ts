// Preloaded into every test process (bunfig.toml). The store trashes PDFs with send2trash, which
// uses $XDG_DATA_HOME/Trash for a file on the home file system; a scratch data home keeps every
// PDF a test deletes or sends out of the user's own trash, and a scratch cache home keeps test
// thumbnails out of the user's cache.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../src/contract/config";

export const SCRATCH_DATA_HOME = mkdtempSync(join(tmpdir(), "pdf-bucket-test-data-"));
process.env.XDG_DATA_HOME = SCRATCH_DATA_HOME;
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "pdf-bucket-test-cache-"));

// The suites drive the app's server over HTTP through `pdf-bucket serve` (tests/bucket.ts);
// cargo rebuilds it only when its sources changed.
const built = Bun.spawnSync(["cargo", "build", "--quiet", "--package", "pdf-bucket", "--bin", "pdf-bucket"], {
  cwd: REPO_ROOT,
  stdout: "inherit",
  stderr: "inherit",
});
if (built.exitCode !== 0) {
  throw new Error(`cargo could not build the pdf-bucket server (exit ${built.exitCode})`);
}
