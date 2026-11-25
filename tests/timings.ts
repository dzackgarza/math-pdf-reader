import { appendFileSync, mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { REPO_ROOT } from "../src/contract/config";

export const TIMINGS_LOG = join(
  process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
  "math-pdf-reader",
  "test-timings.jsonl",
);

const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: REPO_ROOT })
  .stdout.toString()
  .trim();
const dirty = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: REPO_ROOT }).stdout.length > 0;

export function recordTiming(
  test: string,
  measure: string,
  milliseconds: number,
  context: Record<string, string | number>,
): void {
  mkdirSync(dirname(TIMINGS_LOG), { recursive: true });
  appendFileSync(
    TIMINGS_LOG,
    `${JSON.stringify({
      at: new Date().toISOString(),
      revision,
      dirty,
      host: hostname(),
      test,
      measure,
      milliseconds: Math.round(milliseconds),
      ...context,
    })}\n`,
  );
}
