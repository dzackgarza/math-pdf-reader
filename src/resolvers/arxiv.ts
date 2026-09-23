// arXiv resolver: an arXiv id or arxiv.org URL to the BibTeX arXiv exports for it.
import { arxivId } from "./arxivId";
import { fetchOk, invariant, readInput, upstream, writeBibtex } from "./contract";

// arXiv's export names the archive with the natbib fields `archivePrefix` and `primaryClass`;
// biblatex treats them as aliases of `eprinttype` and `eprintclass` (biblatex manual, §3.14.7
// "Electronic Publishing Information"), and Zotero's BibTeX import keeps the eprint only under
// `eprinttype`, as an `arXiv:` line in Extra.
function biblatexEprintFields(bibtex: string): string {
  return bibtex
    .replace(/\barchivePrefix(\s*=)/i, "eprinttype$1")
    .replace(/\bprimaryClass(\s*=)/i, "eprintclass$1");
}

// An old-style id's `/` is part of the id; arXiv answers the escaped form identically.
const id = arxivId(await readInput());
invariant(id.length > 0, "arXiv resolver input names no arXiv id");
const response = await fetchOk(upstream(`/bibtex/${encodeURIComponent(id)}`), "text/plain");
writeBibtex(biblatexEprintFields(await response.text()));
