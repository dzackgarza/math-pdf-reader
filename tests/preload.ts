// Preloaded into every test process (bunfig.toml). The store trashes PDFs with send2trash, which
// uses $XDG_DATA_HOME/Trash for a file on the home file system; a scratch data home keeps every
// PDF a test deletes or sends out of the user's own trash.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SCRATCH_DATA_HOME = mkdtempSync(join(tmpdir(), "pdf-bucket-test-data-"));
process.env.XDG_DATA_HOME = SCRATCH_DATA_HOME;
