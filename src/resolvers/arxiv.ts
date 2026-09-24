// arXiv resolver: an arXiv id or arxiv.org URL to the BibTeX arXiv exports for it.

import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import { arxivId } from "./arxivId";
import { fetchOk, invariant, readInput, text, upstream, writeBibtex } from "./contract";

// arXiv's export names the archive with the natbib fields `archivePrefix` and `primaryClass`;
// biblatex treats them as aliases of `eprinttype` and `eprintclass` (biblatex manual, §3.14.7
// "Electronic Publishing Information"), and Zotero's BibTeX import keeps the eprint only under
// `eprinttype`, as an `arXiv:` line in Extra.
function biblatexEprintFields(bibtex: string): string {
  return bibtex
    .replace(/\barchivePrefix(\s*=)/i, "eprinttype$1")
    .replace(/\bprimaryClass(\s*=)/i, "eprintclass$1");
}

// arXiv's BibTeX export carries no abstract; its API's Atom entry does (<summary>). A LaTeX
// abstract keeps balanced braces as written; one with an unbalanced brace has every brace
// escaped, since BibTeX ends a braced value at its balancing brace.
function withAbstract(bibtex: string, abstract: string): string {
  let depth = 0;
  for (const character of abstract) {
    depth += character === "{" ? 1 : character === "}" ? -1 : 0;
    if (depth < 0) {
      break;
    }
  }
  const value = depth === 0 ? abstract : abstract.replace(/[{}]/g, (brace) => `\\${brace}`);
  const [head, ...rest] = bibtex.trim().split("\n");
  invariant(head?.endsWith(","), `arXiv BibTeX does not open with its key line: ${head}`);
  return [head, `      abstract={${value}},`, ...rest].join("\n");
}

// The part of arXiv's Atom answer for one id that is read: its entry's summary. An id arXiv
// does not know answers a feed without an entry.
const AtomSchema = z.object({
  feed: z.object({ entry: z.object({ summary: z.string() }).optional() }),
});

async function abstractOf(id: string): Promise<string | null> {
  const atom = await fetchOk(
    upstream(`/api/query?id_list=${encodeURIComponent(id)}`),
    "application/atom+xml",
  );
  const feed = AtomSchema.parse(new XMLParser().parse(await atom.text()));
  return feed.feed.entry === undefined ? null : text(feed.feed.entry.summary);
}

// An old-style id's `/` is part of the id; arXiv answers the escaped form identically.
const id = arxivId(await readInput());
invariant(id.length > 0, "arXiv resolver input names no arXiv id");
const response = await fetchOk(upstream(`/bibtex/${encodeURIComponent(id)}`), "text/plain");
const bibtex = biblatexEprintFields(await response.text());
const abstract = await abstractOf(id);
writeBibtex(abstract === null ? bibtex : withAbstract(bibtex, abstract));
