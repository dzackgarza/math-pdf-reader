// The shipped plugin manifests, read with the one schema per manifest kind the server reads them
// with: each lists its plugins, and each plugin's command runs where the server runs it.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REPO_ROOT } from "../src/contract/config";
import { ExtractionManifestSchema, ResolverManifestSchema } from "../src/contract/extraction";
import { EXTRACTIONS_MANIFEST, RESOLVERS_MANIFEST } from "./bucket";

const extractions = ExtractionManifestSchema.parse(
  JSON.parse(readFileSync(EXTRACTIONS_MANIFEST, "utf8")),
);
const resolvers = ResolverManifestSchema.parse(
  JSON.parse(readFileSync(RESOLVERS_MANIFEST, "utf8")),
);

test("the shipped manifests list the shipped plugins", () => {
  expect(extractions.plugins.map((plugin) => plugin.id)).toEqual([
    "mineru-flash",
    "mineru-precise",
    "mistral-ocr",
  ]);
  expect(resolvers.plugins.map((plugin) => plugin.id)).toEqual(["doi", "isbn", "arxiv", "zbmath"]);
});

test("every extraction command is on the PATH the server gives plugins and takes the PDF and its output", () => {
  // The server puts the Python environment's bin directory first on the plugins' PATH.
  const path = `${join(REPO_ROOT, ".venv/bin")}:${process.env.PATH}`;
  for (const plugin of extractions.plugins) {
    const [program, ...rest] = plugin.command;
    if (program === undefined) {
      throw new Error(`plugin ${plugin.id} names no command`);
    }
    expect(Bun.which(program, { PATH: path }), plugin.id).not.toBeNull();
    expect(
      rest.some((argument) => argument.includes("$pdf")),
      plugin.id,
    ).toBe(true);
    expect(
      rest.some((argument) => argument.includes("$output")),
      plugin.id,
    ).toBe(true);
  }
});

test("every resolver script resolves from the manifest's directory, where the server runs it", () => {
  for (const plugin of resolvers.plugins) {
    const [, script] = plugin.command;
    if (script === undefined) {
      throw new Error(`resolver ${plugin.id} names no script`);
    }
    expect(existsSync(join(dirname(RESOLVERS_MANIFEST), script)), plugin.id).toBe(true);
  }
});
