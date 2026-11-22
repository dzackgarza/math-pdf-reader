import { expect, test } from "bun:test";
import {
  ExtractionPluginsResponseSchema,
  pluginAcceptsUrl,
  sourceMatchesUrl,
} from "../src/contract/extraction";

const arxivInput = {
  kind: "pdf" as const,
  id: "pdf",
  label: "arXiv paper",
  limits: [{ kind: "source" as const, value: "arxiv" as const }],
};

test("arXiv source matching recognizes supported arXiv URL forms only", () => {
  expect(sourceMatchesUrl("arxiv", "https://arxiv.org/pdf/2301.01234v2")).toBe(
    true,
  );
  expect(
    sourceMatchesUrl("arxiv", "https://export.arxiv.org/abs/math/0002066"),
  ).toBe(true);
  expect(
    sourceMatchesUrl("arxiv", "https://paulhacking.github.io/mlp.pdf"),
  ).toBe(false);
  expect(
    sourceMatchesUrl("arxiv", "https://arxiv.org/pdf/2301.01234.pdf"),
  ).toBe(false);
});

test("plugin availability is constrained by accepted input source", () => {
  const arxiv = ExtractionPluginsResponseSchema.parse({
    plugins: [
      {
        id: "arxiv-source",
        name: "arXiv LaTeX source",
        source_kind: "arxiv_latex",
        authoritative: true,
        accepted_inputs: [arxivInput],
      },
    ],
  }).plugins[0];
  if (arxiv === undefined) {
    throw new Error("test plugin is missing");
  }
  expect(pluginAcceptsUrl(arxiv, "https://arxiv.org/pdf/2301.01234")).toBe(
    true,
  );
  expect(pluginAcceptsUrl(arxiv, "https://example.org/paper.pdf")).toBe(false);
});
