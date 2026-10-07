// Which navigations are PDF responses to capture, for both browsers. The decision follows
// mozilla/pdf.js extensions/chromium/pdfHandler.js: its declarativeNetRequest rules
// (Chrome 128+, response-header conditions) and, for Firefox, which has no response-header
// rule condition, the same decision as a blocking webRequest.onHeadersReceived predicate.
// Differences from pdf.js: only GET is intercepted, the bucket's own origin is allowed
// through, pdf.js's download escapes (`pdfjs.action=download`, `=download`, attachment
// sub-frames) are dropped because every PDF is captured, `application/x-pdf` counts as PDF,
// and the generic types below, or no Content-Type at all, count as octet-stream does in pdf.js.

import { MIMEType } from "whatwg-mimetype";
import type { Browser } from "wxt/browser";
import { type CaptureOutcome, CaptureOutcomeSchema } from "./messages";

type Rule = Browser.declarativeNetRequest.Rule;

// Top-level documents and iframes; `<embed>`/`<object>` loads are left to the browser.
export const PDF_FRAME_TYPES: ("main_frame" | "sub_frame")[] = ["main_frame", "sub_frame"];

const OCTET_STREAM = "application/octet-stream";

// Media types that say PDF.
const PDF_TYPES = ["application/pdf", "application/x-pdf"];

// Media types servers send for any file (`binary/octet-stream` is Amazon S3's default). With
// one of these, or with no Content-Type, the URL path or Content-Disposition decides.
const GENERIC_TYPES = [OCTET_STREAM, "binary/octet-stream", "application/force-download"];

// declarativeNetRequest header-value patterns (`*` is any run of characters, matched without
// regard to case) for the media types TYPES with or without parameters, including the space or
// tab that may come before the `;`. They also match a value such as `application/pdf x;y`,
// which the MIME parser below rejects; no server sends one.
function mediaTypePatterns(types: string[]): string[] {
  return types.flatMap((type) => [type, `${type};*`, `${type} *;*`, `${type}\t*;*`]);
}

// The capture page receives the PDF URL verbatim as its whole query string.
export function captureTarget(capturePage: string, pdfUrl: string): string {
  return `${capturePage}?${pdfUrl}`;
}

export function pdfUrlFromCaptureQuery(search: string): URL {
  const url = new URL(search.slice(1));
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`capture target is not an http(s) URL: ${url.href}`);
  }
  return url;
}

// Chrome: rules in priority order, highest first. Chrome gives an extension no way to read a
// navigation's response body. A PDF navigation, top-level or in a frame, is therefore turned
// into a download (its Content-Type rewritten to octet-stream, which Chrome saves instead of
// rendering), so the PDF is fetched once and the bucket reads the saved file (downloads.ts).
export function pdfCaptureRules(bucketOrigin: string): Rule[] {
  const download: Rule["action"] = {
    type: "modifyHeaders",
    responseHeaders: [{ header: "content-type", operation: "set", value: OCTET_STREAM }],
  };
  // pdf.js's double negation for "Content-Type is generic or absent". A rule with an excluded
  // response header is matched on the response, like one with a response header.
  const genericOrAbsent = [
    { header: "content-type", excludedValues: mediaTypePatterns(GENERIC_TYPES) },
  ];
  const pdfConditions: Rule["condition"][] = [
    {
      regexFilter: "^.*$",
      requestMethods: ["get"],
      responseHeaders: [{ header: "content-type", values: mediaTypePatterns(PDF_TYPES) }],
    },
    {
      // Generic or missing MIME type, but a PDF according to the file name in the URL.
      regexFilter: "^.*\\.pdf\\b.*$",
      requestMethods: ["get"],
      excludedResponseHeaders: genericOrAbsent,
    },
    {
      // Generic or missing MIME type, but a PDF according to Content-Disposition.
      regexFilter: "^.*$",
      requestMethods: ["get"],
      responseHeaders: [{ header: "content-disposition", values: ["*.pdf", '*.pdf"*', "*.pdf'*"] }],
      excludedResponseHeaders: genericOrAbsent,
    },
  ];
  const rules: Omit<Rule, "id" | "priority">[] = [
    {
      action: { type: "allow" },
      condition: {
        regexFilter: `^${RegExp.escape(bucketOrigin)}/`,
        resourceTypes: PDF_FRAME_TYPES,
      },
    },
    ...pdfConditions.map((condition) => ({
      action: download,
      condition: { ...condition, resourceTypes: PDF_FRAME_TYPES },
    })),
  ];
  return rules.map((rule, index) => ({ ...rule, id: index + 1, priority: rules.length - index }));
}

// The same decision as the three PDF conditions above, one predicate per condition, for
// Firefox and for telling which of Chrome's downloads are captured navigations; it is
// evaluated on the response headers. `mediaType` is the parsed type without parameters (the
// raw value when it does not parse), undefined when there is no Content-Type.
type PdfEvidence = {
  url: string;
  mediaType: string | undefined;
  disposition: string | undefined;
};

const genericOrAbsentType = ({ mediaType }: PdfEvidence) =>
  mediaType === undefined || GENERIC_TYPES.includes(mediaType);

const pdfType = ({ mediaType }: PdfEvidence) =>
  mediaType !== undefined && PDF_TYPES.includes(mediaType);

const pdfPath = (evidence: PdfEvidence) =>
  genericOrAbsentType(evidence) && /\.pdf\b/i.test(evidence.url);

const pdfDisposition = (evidence: PdfEvidence) =>
  genericOrAbsentType(evidence) &&
  evidence.disposition !== undefined &&
  /\.pdf(["']|$)/.test(evidence.disposition);

// The name and value of a response header, the part of either browser's header type read here.
type ResponseHeader = { name: string; value?: string | undefined };

export function isPdfResponse(url: string, headers: ResponseHeader[]): boolean {
  const header = (name: string) =>
    headers.find((candidate) => candidate.name.toLowerCase() === name)?.value?.toLowerCase();
  const contentType = header("content-type");
  const evidence = {
    url,
    mediaType:
      contentType === undefined ? undefined : (MIMEType.parse(contentType)?.essence ?? contentType),
    disposition: header("content-disposition"),
  };
  return [pdfType, pdfPath, pdfDisposition].some((rule) => rule(evidence));
}

// URL without its fragment: the resource a request fetches.
export function withoutFragment(href: string): string {
  const url = new URL(href);
  url.hash = "";
  return url.href;
}

// A capture's outcome outside the capture page (a Chrome download): the capture page shows the
// outcome its fragment carries.
export function outcomeTarget(capturePage: string, pdfUrl: string, outcome: CaptureOutcome): string {
  return `${captureTarget(capturePage, pdfUrl)}#${encodeURIComponent(JSON.stringify(outcome))}`;
}

export function outcomeFromCaptureHash(hash: string): CaptureOutcome | null {
  return hash === ""
    ? null
    : CaptureOutcomeSchema.parse(JSON.parse(decodeURIComponent(hash.slice(1))));
}
