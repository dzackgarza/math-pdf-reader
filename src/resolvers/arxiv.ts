// arXiv resolver: an arXiv id or arxiv.org URL to the BibTeX arXiv exports for it, with the
// abstract from arXiv's API.

import { Cite } from "@citation-js/core";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import { arxivId } from "./arxivId";
import {
  type BibtexEntry,
  bibtexEntry,
  fetchOk,
  invariant,
  readInput,
  text,
  upstream,
  writeBibtex,
} from "./contract";

// The part of arXiv's Atom answer for one id that is read: its entry's summary. An id arXiv
// does not know answers a feed without an entry.
const AtomSchema = z.object({
  feed: z.object({ entry: z.object({ summary: z.string() }).optional() }),
});

// citation-js's BibTeX entries: `properties` holds each field's BibTeX source.
const FormattedSchema = z.array(
  z.object({ type: z.string(), label: z.string(), properties: z.record(z.string(), z.string()) }),
);

async function abstractOf(id: string): Promise<string | undefined> {
  const atom = await fetchOk(
    upstream(`/api/query?id_list=${encodeURIComponent(id)}`),
    "application/atom+xml",
  );
  const feed = AtomSchema.parse(new XMLParser().parse(await atom.text()));
  return feed.feed.entry === undefined ? undefined : text(feed.feed.entry.summary);
}

function field(entry: BibtexEntry, name: string): string {
  const value = entry.properties[name];
  invariant(value !== undefined, `arXiv BibTeX has no ${name} field`);
  return value;
}

// citation-js's BibTeX layout (plugin-bibtex lib/output/bibtex.js, formatEntry), for an entry
// whose values are already BibTeX source.
function bibtexSource(entry: z.infer<typeof FormattedSchema>[number]): string {
  const fields = Object.entries(entry.properties).map(([name, value]) => `\t${name} = {${value}},`);
  return [`@${entry.type}{${entry.label},`, ...fields, "}"].join("\n");
}

// An old-style id's `/` is part of the id; arXiv answers the escaped form identically.
const id = arxivId(await readInput());
invariant(id.length > 0, "arXiv resolver input names no arXiv id");
const response = await fetchOk(upstream(`/bibtex/${encodeURIComponent(id)}`), "text/plain");
const exported = await response.text();
const eprint = bibtexEntry(exported);
const [record] = new Cite(exported).data;
invariant(record !== undefined, "arXiv BibTeX holds no entry");
// The abstract travels as CSL, so citation-js escapes it into BibTeX. Its object output is
// typed as a union with its text output, so the entries are read through their schema.
const [entry] = FormattedSchema.parse(
  new Cite([{ ...record, abstract: await abstractOf(id) }]).format("biblatex", { format: "object" }),
);
invariant(entry !== undefined, "citation-js formatted no entry");
// CSL has no arXiv eprint fields, so they come from arXiv's own entry. arXiv names the archive
// with the natbib fields `archivePrefix` and `primaryClass`; biblatex treats them as aliases of
// `eprinttype` and `eprintclass` (biblatex manual, §3.14.7 "Electronic Publishing Information"),
// and Zotero's BibTeX import keeps the eprint only under `eprinttype`, as an `arXiv:` line in
// Extra.
writeBibtex(
  bibtexSource({
    ...entry,
    properties: {
      ...entry.properties,
      eprint: field(eprint, "eprint"),
      eprinttype: field(eprint, "archiveprefix"),
      eprintclass: field(eprint, "primaryclass"),
    },
  }),
);
