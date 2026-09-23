// DOI resolver: a DOI or doi.org URL to the BibTeX its registration agency serves by content
// negotiation.
import { fetchOk, invariant, readInput, upstream, writeBibtex } from "./contract";

const DOI_HOSTS = new Set(["doi.org", "dx.doi.org"]);

// In a doi.org URL, `?` and `#` start the query and fragment; in a bare DOI they belong to
// the opaque suffix. Only a doi.org host makes a URL's path a DOI.
function doiFromInput(input: string): string {
  if (!/^https?:\/\//i.test(input)) {
    return input;
  }
  const url = new URL(input);
  invariant(DOI_HOSTS.has(url.hostname), `DOI URL host must be doi.org, got ${url.hostname}`);
  return decodeURIComponent(url.pathname.slice(1));
}

// The suffix travels percent-encoded so a `?` or `#` in it stays part of the path.
function requestPath(doi: string): string {
  const slash = doi.indexOf("/");
  invariant(slash > 0 && slash < doi.length - 1, `not a DOI: ${doi}`);
  return `/${doi.slice(0, slash)}/${encodeURIComponent(doi.slice(slash + 1))}`;
}

const doi = doiFromInput(await readInput());
const response = await fetchOk(upstream(requestPath(doi)), "application/x-bibtex");
writeBibtex(await response.text());
