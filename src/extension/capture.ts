// The capture client, run in the background: fetch the PDF with the browser's cookies,
// post it to the bucket, and report exactly one outcome. The background, not the capture
// page, fetches: Firefox sends no cookies from an extension page framed inside a site.
// The bucket derives the item key from the posted filename.
import { parse as parseContentDisposition } from "content-disposition";
import { CaptureResponseSchema } from "../contract/capture";
import { ApiErrorSchema } from "../contract/library";
import type { CaptureOutcome, LinkOrigin } from "./messages";

// The first non-empty candidate in order of preference; `last` is never empty.
function preferred(candidates: (string | undefined)[], last: string): string {
  const [first] = candidates.filter((name): name is string => name !== undefined && name !== "");
  return first === undefined ? last : first;
}

// Content-Disposition filename, else the URL's last path segment, else the host name.
function captureFilename(pdfUrl: URL, contentDisposition: string | null): string {
  const declared =
    contentDisposition === null
      ? undefined
      : parseContentDisposition(contentDisposition).parameters.filename;
  const segment = decodeURIComponent(pdfUrl.pathname.slice(pdfUrl.pathname.lastIndexOf("/") + 1));
  return preferred([declared, segment], pdfUrl.hostname);
}

// Link text, else the linking page's title, else the filename.
function titleHint(origin: LinkOrigin | undefined, filename: string): string {
  return preferred([origin?.link_text, origin?.page_title], filename);
}

type Settled = { ok: true; response: Response } | { ok: false; detail: string };

// A rejected fetch (network error, bucket not listening) becomes a reportable outcome.
function settle(request: Promise<Response>): Promise<Settled> {
  return request.then(
    (response) => ({ ok: true, response }),
    (error: unknown) => ({ ok: false, detail: String(error) }),
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// The bucket refuses a capture with its error envelope; any other body did not come from it.
async function refusal(response: Response): Promise<string> {
  const status = `${response.status} ${response.statusText}`;
  const body = await response.text();
  const envelope = ApiErrorSchema.safeParse(parseJson(body));
  return envelope.success
    ? `${status} ${envelope.data.error.kind}: ${envelope.data.error.message}`
    : `${status}, not a PDF Bucket error document: ${body}`;
}

export async function capturePdf(
  pdfUrl: URL,
  origin: LinkOrigin | undefined,
  bucketOrigin: string,
): Promise<CaptureOutcome> {
  const pdf = await settle(fetch(pdfUrl, { credentials: "include" }));
  if (!pdf.ok) {
    return { kind: "failed", error: { stage: "fetch-pdf", detail: pdf.detail } };
  }
  if (!pdf.response.ok) {
    const detail = `${pdf.response.status} ${pdf.response.statusText}`;
    return { kind: "failed", error: { stage: "fetch-pdf", detail } };
  }
  const filename = captureFilename(pdfUrl, pdf.response.headers.get("content-disposition"));
  const form = new FormData();
  form.set("pdf", new File([await pdf.response.blob()], filename, { type: "application/pdf" }));
  form.set("pdf_url", pdfUrl.href);
  // A PDF opened without a followed link (typed in, bookmarked, framed) has no linking page.
  if (origin !== undefined) {
    form.set("source_url", origin.source_url);
  }
  form.set("title_hint", titleHint(origin, filename));

  const posted = await settle(
    fetch(`${bucketOrigin}/capture-bytes`, { method: "POST", body: form }),
  );
  if (!posted.ok) {
    const detail = `PDF Bucket is not reachable at ${bucketOrigin} (${posted.detail})`;
    return { kind: "failed", error: { stage: "post-bucket", detail } };
  }
  if (!posted.response.ok) {
    const detail = await refusal(posted.response);
    return { kind: "failed", error: { stage: "post-bucket", detail } };
  }
  return { kind: "stored", response: CaptureResponseSchema.parse(await posted.response.json()) };
}
