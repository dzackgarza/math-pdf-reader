// @citation-js/name ships no types. `format` is its CSL name display (lib/output.js): the
// literal name, else dropping particle, given, suffix, non-dropping particle and family.
declare module "@citation-js/name" {
  import type { CSLName } from "@citation-js/core";
  export function format(name: CSLName, reversed?: boolean): string;
}
