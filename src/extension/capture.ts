// The capture client, run in the background: post the PDF the browser received to the bucket
// and report exactly one outcome. Where the bytes come from is the interception's business
// (Firefox: the navigation's own response; Chrome: a download it saved, or `refetchPdf` for a
// PDF in a frame). The bucket derives the item key from the posted filename.
import { parse as parseContentDisposition } from "content-disposition";
import decodeUriComponent from "decode-uri-component";
import { type CaptureDownloadRequest, CaptureResponseSchema } from "../contract/capture";
import { ApiErrorSchema } from "../contract/library";
import { checkedBody } from "./json";
import { type CaptureOutcome, type Failed, failed, type LinkOrigin } from "./messages";

// The PDF's bytes and the Content-Disposition header that came with them.
export type ReceivedPdf = { bytes: Blob; contentDisposition: string | null };

export type Received = { kind: "received"; pdf: ReceivedPdf } | Failed;

// The first non-empty candidate in order of preference; `last` is never empty.
function preferred(candidates: (string | undefined)[], last: string): string {
  const [first] = candidates.filter((name): name is string => name !== undefined && name !== "");
  return first === undefined ? last : first;
}

// Content-Disposition filename, else the URL's last path segment, else the host name. The
// segment is decoded as far as it is valid UTF-8; other escapes (`caf%E9.pdf`, Latin-1) stay.
function captureFilename(pdfUrl: URL, contentDisposition: string | null): string {
  const declared =
    contentDisposition === null
      ? undefined
      : parseContentDisposition(contentDisposition).parameters.filename;
  const segment = decodeUriComponent(pdfUrl.pathname.slice(pdfUrl.pathname.lastIndexOf("/") + 1));
  return preferred([declared, segment], pdfUrl.hostname);
}

// Link text, else the linking page's title, else the filename.
function titleHint(origin: LinkOrigin | undefined, filename: string): string {
  return preferred([origin?.link_text, origin?.page_title], filename);
}

type Settled<T> = { ok: true; value: T } | { ok: false; detail: string };

// A rejected promise (network error, bucket not listening, body cut off) becomes a
// reportable outcome.
function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, detail: String(error) }),
  );
}

// Chrome cannot read a PDF's response body in a frame, so the background fetches it again
// with the browser's cookies.
export async function refetchPdf(pdfUrl: URL): Promise<Received> {
  const answered = await settle(fetch(pdfUrl, { credentials: "include" }));
  if (!answered.ok) {
    return failed("fetch-pdf", answered.detail);
  }
  const response = answered.value;
  if (!response.ok) {
    return failed("fetch-pdf", `${response.status} ${response.statusText}`);
  }
  const bytes = await settle(response.blob());
  if (!bytes.ok) {
    return failed("fetch-pdf", `the PDF's body could not be read (${bytes.detail})`);
  }
  return {
    kind: "received",
    pdf: { bytes: bytes.value, contentDisposition: response.headers.get("content-disposition") },
  };
}

// The bucket refuses a capture with its error envelope; any other body did not come from it.
async function refusal(response: Response): Promise<Failed> {
  const status = `${response.status} ${response.statusText}`;
  const envelope = await checkedBody(response, ApiErrorSchema);
  const detail = envelope.ok
    ? `${status} ${envelope.value.error.kind}: ${envelope.value.error.message}`
    : `${status}, not a PDF Bucket error document: ${envelope.detail}`;
  return failed("post-bucket", detail);
}

// The bucket's answer to a capture post (or the post's failure) as the capture's outcome.
async function captureOutcome(
  post: Promise<Response>,
  bucketOrigin: string,
): Promise<CaptureOutcome> {
  const posted = await settle(post);
  if (!posted.ok) {
    return failed(
      "post-bucket",
      `PDF Bucket is not reachable at ${bucketOrigin} (${posted.detail})`,
    );
  }
  if (!posted.value.ok) {
    return refusal(posted.value);
  }
  const answer = await checkedBody(posted.value, CaptureResponseSchema);
  if (!answer.ok) {
    return failed(
      "post-bucket",
      `${bucketOrigin} answered, but not with a capture response: ${answer.detail}`,
    );
  }
  return { kind: "stored", response: answer.value };
}

export function postToBucket(
  pdfUrl: URL,
  pdf: ReceivedPdf,
  origin: LinkOrigin | undefined,
  bucketOrigin: string,
): Promise<CaptureOutcome> {
  const filename = captureFilename(pdfUrl, pdf.contentDisposition);
  const form = new FormData();
  form.set("pdf", new File([pdf.bytes], filename, { type: "application/pdf" }));
  form.set("pdf_url", pdfUrl.href);
  // A PDF opened without a followed link (typed in, bookmarked, framed) has no linking page.
  if (origin !== undefined) {
    form.set("source_url", origin.source_url);
  }
  form.set("title_hint", titleHint(origin, filename));
  return captureOutcome(
    fetch(`${bucketOrigin}/capture-bytes`, { method: "POST", body: form }),
    bucketOrigin,
  );
}

// A PDF Chrome saved as a download at PATH: the bucket reads the file.
export function postDownloadToBucket(
  pdfUrl: URL,
  path: string,
  contentDisposition: string | null,
  origin: LinkOrigin | undefined,
  bucketOrigin: string,
): Promise<CaptureOutcome> {
  const filename = captureFilename(pdfUrl, contentDisposition);
  const request: CaptureDownloadRequest = {
    path,
    filename,
    pdf_url: pdfUrl.href,
    ...(origin === undefined ? {} : { source_url: origin.source_url }),
    title_hint: titleHint(origin, filename),
  };
  return captureOutcome(
    fetch(`${bucketOrigin}/capture-download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }),
    bucketOrigin,
  );
}
