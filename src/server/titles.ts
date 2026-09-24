// Item titles and authors from the identifier resolvers ("Retrieve metadata", as Zotero names
// it): the store finds an identifier for the item and runs the resolver plugin that accepts
// it; the title and authors in the BibTeX the resolver prints become the item's, recorded
// inside the PDF. Without a resolver the store reads both from the PDF itself.
import { Cite } from "@citation-js/core";
import { format } from "@citation-js/name";
import "@citation-js/plugin-bibtex";
import type { RetrieveMetadataOutcome } from "./libraryContract";
import { type ResolvedMetadata, recordMetadata, resolveItem } from "./store";

// citation-js parses the entry to CSL, which also turns the BibTeX's LaTeX into text and
// splits `author` into CSL names (given and family, or one literal name).
export function bibtexMetadata(bibtex: string): ResolvedMetadata {
  const [entry] = new Cite(bibtex).data;
  const title = entry?.title?.trim();
  if (title === undefined || title === "") {
    throw new Error(`resolver BibTeX carries no title: ${bibtex.slice(0, 200)}`);
  }
  const authors = (entry?.author ?? []).map((name) => format(name));
  const year = entry?.issued?.["date-parts"]?.[0]?.[0];
  const abstract = entry?.abstract?.trim();
  return {
    title,
    authors,
    year: year === undefined ? null : Number(year),
    abstract: abstract === undefined || abstract === "" ? null : abstract,
  };
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
      const metadata = bibtexMetadata(resolution.bibtex);
      const { title } = metadata;
      await recordMetadata(root, key, "resolver", metadata);
      return {
        status: "resolved",
        pluginId: resolution.plugin_id,
        identifier: resolution.identifier,
        title,
      };
    }
  }
}
