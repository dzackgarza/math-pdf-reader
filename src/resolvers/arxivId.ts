// The arXiv id in an arXiv id or arxiv.org URL, as the resolver manifest's patterns accept them.
// The query and fragment go before the `.pdf` suffix, which is only a suffix without them.
export function arxivId(input: string): string {
  return input
    .split("?")[0]
    .split("#")[0]
    .replace(/^arxiv:/i, "")
    .replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf)\//i, "")
    .replace(/\.pdf$/i, "");
}
