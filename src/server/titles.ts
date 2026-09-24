// Item titles from the identifier resolvers ("Retrieve metadata", as Zotero names it): the
// store finds an identifier for the item and runs the resolver plugin that accepts it; the
// title in the BibTeX the resolver prints becomes the item's title, recorded inside the PDF.
// Without a resolver title the store reads the title from the PDF itself.
import { Cite } from "@citation-js/core";
import "@citation-js/plugin-bibtex";
import type { RetrieveMetadataOutcome } from "./libraryContract";
import { recordTitle, resolveItem } from "./store";

// citation-js parses the entry to CSL, which also turns the BibTeX's LaTeX into text.
export function bibtexTitle(bibtex: string): string {
  const [entry] = new Cite(bibtex).data;
  const title = entry?.title?.trim();
  if (title === undefined || title === "") {
    throw new Error(`resolver BibTeX carries no title: ${bibtex.slice(0, 200)}`);
  }
  return title;
}

export async function retrieveMetadata(
  root: string,
  key: string,
  resolversManifest: string,
): Promise<RetrieveMetadataOutcome> {
  const resolution = await resolveItem(root, key, resolversManifest);
  switch (resolution.status) {
    case "unidentified":
      return { status: "unidentified" };
    case "failed":
      return {
        status: "failed",
        pluginId: resolution.plugin_id,
        identifier: resolution.identifier,
        message: `exit ${resolution.exit_code}: ${resolution.stderr.trim()}`,
      };
    case "resolved": {
      const title = bibtexTitle(resolution.bibtex);
      await recordTitle(root, key, title, "resolver");
      return {
        status: "resolved",
        pluginId: resolution.plugin_id,
        identifier: resolution.identifier,
        title,
      };
    }
  }
}
