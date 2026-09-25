// Which navigations are PDF responses to capture, for both browsers. The decision follows
// mozilla/pdf.js extensions/chromium/pdfHandler.js: its declarativeNetRequest rules
// (Chrome 128+, response-header conditions) and, for Firefox, which has no response-header
// rule condition, the same decision as a blocking webRequest.onHeadersReceived predicate.
// Differences from pdf.js: only GET is intercepted, the bucket's own origin is allowed
// through, and pdf.js's download escapes (`pdfjs.action=download`, `=download`,
// attachment sub-frames) are dropped because every PDF is captured.
import type { Browser } from "wxt/browser";
import { type Failed, FailedSchema } from "./messages";

type Rule = Browser.declarativeNetRequest.Rule;

// Top-level documents and iframes; `<embed>`/`<object>` loads are left to the browser.
export const PDF_FRAME_TYPES: ("main_frame" | "sub_frame")[] = ["main_frame", "sub_frame"];

const OCTET_STREAM = "application/octet-stream";

// The capture page receives the PDF URL verbatim as its whole query string:
// declarativeNetRequest cannot encode the matched URL, so Firefox does the same.
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
// navigation's response body. A top-level PDF navigation is therefore turned into a download
// (its Content-Type rewritten to octet-stream, which Chrome saves instead of rendering), so the
// PDF is fetched once and the bucket reads the saved file (chrome-downloads.ts). A PDF in a
// frame is redirected to the capture page, which fetches it again and keeps one line in the
// frame, or hands a small frame back to the browser's viewer.
export function pdfCaptureRules(capturePage: string, bucketOrigin: string): Rule[] {
  const redirect: Rule["action"] = {
    type: "redirect",
    redirect: { regexSubstitution: captureTarget(capturePage, "\\0") },
  };
  const download: Rule["action"] = {
    type: "modifyHeaders",
    responseHeaders: [{ header: "content-type", operation: "set", value: OCTET_STREAM }],
  };
  const pdfConditions: Rule["condition"][] = [
    {
      regexFilter: "^.*$",
      requestMethods: ["get"],
      responseHeaders: [
        { header: "content-type", values: ["application/pdf", "application/pdf;*"] },
      ],
    },
    {
      // Wrong MIME type, but a PDF according to the file name in the URL.
      regexFilter: "^.*\\.pdf\\b.*$",
      requestMethods: ["get"],
      responseHeaders: [
        {
          header: "content-type",
          values: ["application/octet-stream", "application/octet-stream;*"],
        },
      ],
    },
    {
      // Wrong or missing MIME type, but a PDF according to Content-Disposition. The
      // excluded header is pdf.js's double negation for "Content-Type is octet-stream or absent".
      regexFilter: "^.*$",
      requestMethods: ["get"],
      responseHeaders: [{ header: "content-disposition", values: ["*.pdf", '*.pdf"*', "*.pdf'*"] }],
      excludedResponseHeaders: [
        {
          header: "content-type",
          excludedValues: ["application/octet-stream", "application/octet-stream;*"],
        },
      ],
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
    ...pdfConditions.flatMap((condition) => [
      { action: download, condition: { ...condition, resourceTypes: ["main_frame" as const] } },
      { action: redirect, condition: { ...condition, resourceTypes: ["sub_frame" as const] } },
    ]),
  ];
  return rules.map((rule, index) => ({ ...rule, id: index + 1, priority: rules.length - index }));
}

// The same decision as the three PDF conditions above, one predicate per condition, for
// Firefox and for telling which of Chrome's downloads are captured navigations; it is
// evaluated on the response headers (values lower-cased; the media type without parameters).
type PdfEvidence = {
  url: string;
  contentType: string | undefined;
  disposition: string | undefined;
};

const pdfContentType = ({ contentType }: PdfEvidence) => contentType === "application/pdf";

const pdfPathOctetStream = ({ url, contentType }: PdfEvidence) =>
  contentType === OCTET_STREAM && /\.pdf\b/i.test(url);

const pdfDisposition = ({ contentType, disposition }: PdfEvidence) =>
  (contentType === undefined || contentType === OCTET_STREAM) &&
  disposition !== undefined &&
  /\.pdf(["']|$)/.test(disposition);

// The name and value of a response header, the part of either browser's header type read here.
type ResponseHeader = { name: string; value?: string | undefined };

export function isPdfResponse(url: string, headers: ResponseHeader[]): boolean {
  const header = (name: string) =>
    headers.find((candidate) => candidate.name.toLowerCase() === name)?.value?.toLowerCase();
  const evidence = {
    url,
    contentType: header("content-type")?.split(";", 1)[0]?.trim(),
    disposition: header("content-disposition"),
  };
  return [pdfContentType, pdfPathOctetStream, pdfDisposition].some((rule) => rule(evidence));
}

// URL without its fragment: the resource a request fetches.
export function withoutFragment(href: string): string {
  const url = new URL(href);
  url.hash = "";
  return url.href;
}

// A capture that failed outside the capture page (a Chrome download): the capture page shows
// the failure its fragment carries.
export function failureTarget(capturePage: string, pdfUrl: string, failure: Failed): string {
  return `${captureTarget(capturePage, pdfUrl)}#${encodeURIComponent(JSON.stringify(failure))}`;
}

export function failureFromCaptureHash(hash: string): Failed | null {
  return hash === "" ? null : FailedSchema.parse(JSON.parse(decodeURIComponent(hash.slice(1))));
}
