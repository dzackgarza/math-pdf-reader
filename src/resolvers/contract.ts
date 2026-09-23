// The resolver plugin contract: the identifier or URL arrives on stdin, the upstream service's
// base URL is the first argument, and exactly one BibTeX entry leaves on stdout. A broken
// invariant exits 1 with its reason as the whole of stderr.
import { Cite, type CSL, type CSLName } from "@citation-js/core";
import "@citation-js/plugin-bibtex";

export function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) {
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}

export async function readInput(): Promise<string> {
  const input = (await Bun.stdin.text()).trim();
  invariant(input.length > 0, "resolver input must not be empty");
  return input;
}

// The upstream base URL the manifest passes, so a replay of captured responses can stand in
// for the live service.
export function upstream(path: string): URL {
  const base = process.argv[2];
  invariant(base !== undefined, "resolver requires the upstream base URL as its first argument");
  return new URL(path, base);
}

export async function fetchOk(url: URL, accept: string): Promise<Response> {
  const response = await fetch(url, { headers: { Accept: accept } });
  invariant(response.ok, `${url.href} answered HTTP ${response.status}`);
  return response;
}

// Whitespace runs collapse to one space.
export function text(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  invariant(collapsed.length > 0, "a metadata field must not be blank");
  return collapsed;
}

// A "Family, Given" name keeps its two parts; any other name stays one literal. citation-js
// wraps a name in braces without escaping interior braces, so a brace inside a name would
// produce unbalanced BibTeX; a brace is never part of a personal name.
export function personName(name: string): CSLName {
  const value = text(name);
  invariant(!/[{}]/.test(value), `author name must not contain a BibTeX brace: ${value}`);
  const [family, given, ...rest] = value.split(", ");
  if (family === undefined || given === undefined || rest.length > 0) {
    return { literal: value };
  }
  return { family, given };
}

// The first four-digit year in a free-text date ("April 1, 1997", "1965").
export function yearOf(date: string): number {
  const match = /\d{4}/.exec(date);
  invariant(match !== null, `date must contain a four-digit year: ${date}`);
  return Number.parseInt(match[0], 10);
}

export function cslBibtex(record: CSL & { id: string }): string {
  return new Cite([{ ...record, "citation-key": record.id }]).format("bibtex");
}

export function writeBibtex(bibtex: string): void {
  const entry = bibtex.trim();
  invariant(entry.startsWith("@"), "the upstream answer is not a BibTeX entry");
  process.stdout.write(`${entry}\n`);
}
