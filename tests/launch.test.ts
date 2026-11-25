import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { REPO_ROOT } from "../src/contract/config";

const CHECKOUT_FILES = [
  ".gitignore",
  "src",
  "server",
  "desktop",
  "plugins",
  "scripts",
  "pdf-bucket.config.json",
  "pyproject.toml",
  "uv.lock",
  "package.json",
  "bun.lock",
  "Cargo.toml",
  "Cargo.lock",
  "tsconfig.json",
  "tsconfig.base.json",
  "wxt.config.ts",
  "justfile",
];

type Scratch = {
  repo: string;
  home: string;
  data: string;
  config: string;
  record: string;
  env: Record<string, string>;
  recorded(program: string): string[];
  fingerprint(): string;
};

function executableFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

function program(bin: string, name: string, body: string): void {
  executableFile(
    join(bin, name),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$RECORD/${name}"\n${body}\n`,
  );
}

function scratchCheckout(): Scratch {
  const base = mkdtempSync(join(tmpdir(), "pdf-bucket-launch-"));
  const repo = join(base, "checkout");
  const home = join(base, "home");
  const data = join(home, ".local/share");
  const config = join(home, ".config");
  const record = join(base, "record");
  const bin = join(base, "bin");
  for (const dir of [repo, data, config, record, bin]) mkdirSync(dir, { recursive: true });
  const listed = Bun.spawnSync(
    ["git", "ls-files", "-co", "--exclude-standard", "-z", "--", ...CHECKOUT_FILES],
    { cwd: REPO_ROOT, env: process.env },
  );
  for (const file of listed.stdout.toString().split("\0").filter((name) => name !== "")) {
    if (!existsSync(join(REPO_ROOT, file))) continue;
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    copyFileSync(join(REPO_ROOT, file), join(repo, file));
  }
  program(bin, "kitty", '[[ "$1" == --title ]] && shift 2\nexec "$@"');
  program(bin, "notify-send", "exit 0");
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    XDG_DATA_HOME: data,
    XDG_CONFIG_HOME: config,
    RECORD: record,
  } as Record<string, string>;
  const git = Bun.spawnSync(["git", "-c", "init.defaultBranch=main", "init", "-q"], {
    cwd: repo,
    env,
  });
  if (git.exitCode !== 0) throw new Error(`git init failed in ${repo}: ${git.stderr}`);
  return {
    repo,
    home,
    data,
    config,
    record,
    env,
    recorded: (name) => {
      const path = join(record, name);
      return existsSync(path) ? readFileSync(path, "utf8").split("\n").slice(0, -1) : [];
    },
    fingerprint: () => {
      const run = Bun.spawnSync([join(repo, "scripts/source-fingerprint")], { cwd: repo, env });
      if (run.exitCode !== 0) throw new Error(`source-fingerprint failed: ${run.stderr}`);
      return run.stdout.toString().trim();
    },
  };
}

describe("the application input hash", () => {
  test.each([
    "src/extension/bucket-status.ts",
    "wxt.config.ts",
    "scripts/amo_signed.py",
    "scripts/firefox-policy.sh",
  ])("an edit to the extension input %s leaves it unchanged", (file) => {
    const scratch = scratchCheckout();
    const before = scratch.fingerprint();

    appendFileSync(join(scratch.repo, file), "\n");

    expect(scratch.fingerprint()).toBe(before);
  });

  test("an edit to the library source changes it", () => {
    const scratch = scratchCheckout();
    const before = scratch.fingerprint();

    appendFileSync(join(scratch.repo, "src/web/index.html"), "\n");

    expect(scratch.fingerprint()).not.toBe(before);
  });
});
