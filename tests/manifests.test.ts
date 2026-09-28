// The shipped extraction manifest, read with the schema the server reads it with: it lists its
// plugins, and each plugin's command runs where the server runs it.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../src/contract/config";
import { ExtractionManifestSchema } from "../src/contract/extraction";
import { EXTRACTIONS_MANIFEST } from "./bucket";

const extractions = ExtractionManifestSchema.parse(
  JSON.parse(readFileSync(EXTRACTIONS_MANIFEST, "utf8")),
);

test("the shipped manifest lists the shipped extraction plugins", () => {
  expect(extractions.plugins.map((plugin) => plugin.id)).toEqual([
    "mineru-flash",
    "mineru-precise",
    "mistral-ocr",
  ]);
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
