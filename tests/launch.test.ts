import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
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
import { AppBuildSchema } from "../src/contract/library";
import { closedPortUrl, EXTRACTIONS_MANIFEST, serveBucket } from "./bucket";

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
const FIXTURES = join(REPO_ROOT, "tests/fixtures/launch");

type Scratch = {
  repo: string;
  home: string;
  data: string;
  config: string;
  env: Record<string, string>;
  recorded(program: string): string[];
  fingerprint(): string;
  stamp(): string | null;
};

function scratchCheckout(): Scratch {
  const base = mkdtempSync(join(tmpdir(), "pdf-bucket-launch-"));
  const repo = join(base, "checkout");
  const home = join(base, "home");
  const data = join(home, ".local/share");
  const config = join(home, ".config");
  const record = join(base, "record");
  for (const dir of [repo, data, config, record]) mkdirSync(dir, { recursive: true });
  const listed = Bun.spawnSync(
    ["git", "ls-files", "-co", "--exclude-standard", "-z", "--", ...CHECKOUT_FILES],
    { cwd: REPO_ROOT, env: process.env },
  );
  for (const file of listed.stdout.toString().split("\0").filter((name) => name !== "")) {
    if (!existsSync(join(REPO_ROOT, file))) continue;
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    copyFileSync(join(REPO_ROOT, file), join(repo, file));
  }
  const env = {
    ...process.env,
    PATH: `${join(FIXTURES, "bin")}:${process.env.PATH}`,
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
  const stampFile = join(data, "pdf-bucket-app/source-fingerprint");
  return {
    repo,
    home,
    data,
    config,
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
    stamp: () => (existsSync(stampFile) ? readFileSync(stampFile, "utf8").trim() : null),
  };
}

function launcherCheckout(): Scratch {
  const scratch = scratchCheckout();
  copyFileSync(
    join(FIXTURES, "provision-for-launch.sh"),
    join(scratch.repo, "scripts/provision.sh"),
  );
  return scratch;
}

function launch(scratch: Scratch, env: Record<string, string> = {}) {
  return Bun.spawn([join(scratch.repo, "scripts/launch"), "--from-launcher"], {
    cwd: scratch.home,
    env: { ...scratch.env, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function launched(scratch: Scratch, env: Record<string, string> = {}): Promise<number> {
  const run = launch(scratch, env);
  run.stdin.end();
  return run.exited;
}

async function printed(stream: ReadableStream<Uint8Array>, text: string): Promise<string> {
  const decoder = new TextDecoder();
  let output = "";
  for await (const chunk of stream) {
    output += decoder.decode(chunk, { stream: true });
    if (output.includes(text)) return output;
  }
  throw new Error(`the launcher ended without printing ${JSON.stringify(text)}:\n${output}`);
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

describe("the launcher", () => {
  test("with no app installed, and again after a source edit, it rebuilds in the build terminal and then starts the new build", async () => {
    const scratch = launcherCheckout();

    expect(await launched(scratch)).toBe(0);
    appendFileSync(join(scratch.repo, "src/web/index.html"), "\n");
    expect(await launched(scratch)).toBe(0);

    expect(scratch.recorded("kitty")).toHaveLength(2);
    expect(scratch.recorded("kitty")[0]).toBe("--title Math PDF Reader - Building bash -c");
    expect(scratch.recorded("provision")).toEqual(["--for-launch", "--for-launch"]);
    expect(scratch.recorded("app")).toEqual(["build 1 --from-launcher", "build 2 --from-launcher"]);
    expect(scratch.recorded("notify-send")).toEqual([
      "Math PDF Reader Source changed: rebuilding before launch",
      "Math PDF Reader Source changed: rebuilding before launch",
    ]);
  });

  test("with the source unchanged since the last build, it starts the installed build with no rebuild", async () => {
    const scratch = launcherCheckout();
    expect(await launched(scratch)).toBe(0);

    expect(await launched(scratch)).toBe(0);

    expect(scratch.recorded("provision")).toEqual(["--for-launch"]);
    expect(scratch.recorded("kitty")).toHaveLength(1);
    expect(scratch.recorded("app")).toEqual(["build 1 --from-launcher", "build 1 --from-launcher"]);
  });

  test("a failed rebuild keeps its output in a terminal that waits for Enter, sends a critical notification, exits 1 and starts no app", async () => {
    const scratch = launcherCheckout();
    expect(await launched(scratch)).toBe(0);
    appendFileSync(join(scratch.repo, "src/web/index.html"), "\n");

    const run = launch(scratch, { BUILD_FAILS: "1" });
    const output = await printed(run.stdout, "Press Enter to close.");
    await Bun.sleep(300);
    const waiting = run.exitCode;
    run.stdin.write("\n");
    run.stdin.end();

    expect(output).toContain("the build stopped");
    expect(output).toContain("Rebuild failed (exit 3). Press Enter to close.");
    expect(waiting).toBeNull();
    expect(await run.exited).toBe(1);
    expect(scratch.recorded("notify-send").at(-1)).toBe(
      "-u critical Math PDF Reader rebuild failed; see the Math PDF Reader build terminal for details",
    );
    expect(scratch.recorded("app")).toEqual(["build 1 --from-launcher"]);
  });

  test("after a failed rebuild's terminal closes, the app's status reports the failure with its exit status and the file that keeps its output", async () => {
    const scratch = launcherCheckout();
    expect(await launched(scratch)).toBe(0);
    appendFileSync(join(scratch.repo, "src/web/index.html"), "\n");
    expect(await launched(scratch, { BUILD_FAILS: "1" })).toBe(1);

    const appBuild = join(scratch.data, "pdf-bucket-app");
    const app = await serveBucket({
      root: mkdtempSync(join(tmpdir(), "pdf-bucket-launch-root-")),
      zoteroUrl: closedPortUrl(),
      extractionsManifest: EXTRACTIONS_MANIFEST,
      appBuild,
      checkout: scratch.repo,
    });
    try {
      const build = AppBuildSchema.parse(await (await app.request("/api/app-build")).json());

      expect(build).toEqual({
        state: "failed",
        exitStatus: 3,
        log: join(appBuild, "rebuild.log"),
      });
      expect(readFileSync(join(appBuild, "rebuild.log"), "utf8")).toContain("the build stopped");
    } finally {
      await app.stop();
    }
  });

  test("two launches during one rebuild build once, and both start the new build", async () => {
    const scratch = launcherCheckout();

    const exits = await Promise.all([
      launched(scratch, { BUILD_SECONDS: "1" }),
      launched(scratch, { BUILD_SECONDS: "1" }),
    ]);

    expect(exits).toEqual([0, 0]);
    expect(scratch.recorded("provision")).toEqual(["--for-launch"]);
    expect(scratch.recorded("app")).toEqual(["build 1 --from-launcher", "build 1 --from-launcher"]);
  });
});

describe("provisioning for a launch", () => {
  const provision = (scratch: Scratch, env: Record<string, string> = {}) =>
    Bun.spawnSync([join(scratch.repo, "scripts/provision.sh"), "--for-launch"], {
      cwd: scratch.repo,
      env: { ...scratch.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });

  test("stamps the hash of the source it built from, installs the app and its Math PDF Reader entry, and builds no extension", () => {
    const scratch = scratchCheckout();
    const before = scratch.fingerprint();

    const run = provision(scratch, { EDIT_DURING_BUILD: "1" });

    expect(run.exitCode).toBe(0);
    expect(scratch.stamp()).toBe(before);
    expect(scratch.fingerprint()).not.toBe(before);
    expect(existsSync(join(scratch.home, ".local/bin/pdf-bucket-desktop"))).toBe(true);
    const entry = readFileSync(join(scratch.data, "applications/pdf-bucket-desktop.desktop"), "utf8");
    expect(entry).toContain("\nName=Math PDF Reader\n");
    expect(entry).toContain(`\nExec=${join(scratch.home, ".local/bin/pdf-bucket")}\n`);
    expect(scratch.recorded("bunx").filter((call) => call.includes("wxt"))).toEqual([]);
    expect(scratch.recorded("systemctl").filter((call) => call.startsWith("--user start"))).toEqual([]);
  });

  test("a failed build writes no stamp", () => {
    const scratch = scratchCheckout();

    const run = provision(scratch, { BUILD_FAILS: "1" });

    expect(run.exitCode).toBe(3);
    expect(scratch.stamp()).toBeNull();
  });
});

describe("extension provisioning", () => {
  const committed = (scratch: Scratch) => {
    for (const command of [
      ["git", "add", "-A"],
      ["git", "-c", "user.name=test", "-c", "user.email=test@localhost", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "build input"],
    ]) {
      const run = Bun.spawnSync(command, { cwd: scratch.repo, env: scratch.env });
      if (run.exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${run.stderr}`);
    }
    return scratch;
  };
  const extensions = (scratch: Scratch) => join(scratch.data, "pdf-bucket-app/extensions");
  const chromiumLoads = (scratch: Scratch) => {
    const profile = join(scratch.config, "chromium/Default");
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "Preferences"), JSON.stringify({}));
    writeFileSync(
      join(profile, "Secure Preferences"),
      JSON.stringify({ extensions: { settings: { capture: { path: join(extensions(scratch), "chrome-mv3") } } } }),
    );
  };
  const firefoxPolicy = (scratch: Scratch, present: boolean) => {
    const policies = mkdtempSync(join(tmpdir(), "pdf-bucket-policies-"));
    if (present) {
      const policy = Bun.spawnSync([join(scratch.repo, "scripts/firefox-policy.sh")], { cwd: scratch.repo, env: scratch.env });
      writeFileSync(join(policies, "policies.json"), policy.stdout);
    }
    return policies;
  };
  const provisionExtensions = (scratch: Scratch, policies: string) =>
    Bun.spawnSync(
      [
        "unshare",
        "--user",
        "--map-root-user",
        "--mount",
        "bash",
        "-c",
        'mount --bind "$0" /etc/firefox/policies && exec scripts/provision-extensions.sh',
        policies,
      ],
      { cwd: scratch.repo, env: scratch.env, stdout: "pipe", stderr: "pipe" },
    );

  test("with both browsers ready it installs both builds, and with the input unchanged it builds nothing", () => {
    const scratch = committed(scratchCheckout());
    chromiumLoads(scratch);
    const policies = firefoxPolicy(scratch, true);

    const first = provisionExtensions(scratch, policies);
    const builds = scratch.recorded("bunx").length;
    const second = provisionExtensions(scratch, policies);

    expect(first.exitCode).toBe(0);
    expect(existsSync(join(extensions(scratch), "chrome-mv3/manifest.json"))).toBe(true);
    expect(readFileSync(join(extensions(scratch), "firefox.xpi"), "utf8")).toBe("signed\n");
    expect(second.exitCode).toBe(0);
    expect(scratch.recorded("bunx")).toHaveLength(builds);
  });

  test("a Chromium that does not load the build stops only the Chrome build: Firefox's is signed and installed", () => {
    const scratch = committed(scratchCheckout());

    const run = provisionExtensions(scratch, firefoxPolicy(scratch, true));

    expect(run.exitCode).toBe(1);
    expect(readFileSync(join(extensions(scratch), "firefox.xpi"), "utf8")).toBe("signed\n");
    expect(existsSync(join(extensions(scratch), "firefox-mv2/manifest.json"))).toBe(true);
  });

  test("a Firefox without the add-on policy stops only the Firefox build: Chrome's is installed", () => {
    const scratch = committed(scratchCheckout());
    chromiumLoads(scratch);

    const run = provisionExtensions(scratch, firefoxPolicy(scratch, false));

    expect(run.exitCode).toBe(1);
    expect(existsSync(join(extensions(scratch), "chrome-mv3/manifest.json"))).toBe(true);
    expect(existsSync(join(extensions(scratch), "firefox.xpi"))).toBe(false);
  });

  test("uncommitted extension input is refused with its paths, and nothing is built", () => {
    const scratch = committed(scratchCheckout());
    chromiumLoads(scratch);
    appendFileSync(join(scratch.repo, "src/extension/bucket-status.ts"), "\n");

    const run = provisionExtensions(scratch, firefoxPolicy(scratch, true));

    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toContain("src/extension/bucket-status.ts");
    expect(scratch.recorded("bunx")).toEqual([]);
    expect(existsSync(extensions(scratch))).toBe(false);
  });
});
