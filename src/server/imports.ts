// Adding PDFs without the browser: from a URL (a PDF, or a page that names its PDF with the
// Highwire `citation_pdf_url` tag, as arXiv, journals and the bucket's own reader pages do),
// and from a folder on this computer.
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DownloadSettings } from "./sources";
import type { CaptureUpload } from "./store";

type Found = { upload: CaptureUpload } | { failure: string };

function isPdf(bytes: Uint8Array): boolean {
  return new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-";
}

// The name the store keys a PDF under: the URL's last path segment.
function urlFilename(url: string): string {
  const segment = basename(new URL(url).pathname);
  return segment === "" ? "download.pdf" : decodeURIComponent(segment);
}

async function get(url: string, settings: DownloadSettings) {
  const signal = AbortSignal.timeout(settings.download_timeout_seconds * 1000);
  return fetch(url, { signal }).then(
    (response) => response,
    (error: Error) => error,
  );
}

// The Highwire tags and <title> of a page, read with Bun's HTMLRewriter.
async function pageTags(response: Response) {
  const tags = { pdfUrl: "", citationTitle: "", title: "" };
  const rewriter = new HTMLRewriter()
    .on('meta[name="citation_pdf_url"]', {
      element: (element) => {
        tags.pdfUrl = element.getAttribute("content") ?? "";
      },
    })
    .on('meta[name="citation_title"]', {
      element: (element) => {
        tags.citationTitle = element.getAttribute("content") ?? "";
      },
    })
    .on("title", {
      text: (chunk) => {
        tags.title += chunk.text;
      },
    });
  await rewriter.transform(response).text();
  return tags;
}

export async function findPdfAt(url: string, settings: DownloadSettings): Promise<Found> {
  const response = await get(url, settings);
  if (response instanceof Error) {
    return { failure: `${url}: ${response.message}` };
  }
  if (!response.ok) {
    return { failure: `${url}: HTTP ${response.status}` };
  }
  if (!(response.headers.get("Content-Type") ?? "").includes("text/html")) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!isPdf(bytes)) {
      return { failure: `${url} serves no PDF` };
    }
    const upload = { pdf: new File([bytes], urlFilename(url)), pdf_url: url, source_url: url };
    return { upload: { ...upload, title_hint: urlFilename(url) } };
  }
  const tags = await pageTags(response);
  if (tags.pdfUrl === "") {
    return { failure: `${url} names no PDF (no citation_pdf_url)` };
  }
  const pdfUrl = new URL(tags.pdfUrl, url).href;
  const linked = await get(pdfUrl, settings);
  if (linked instanceof Error || !linked.ok) {
    const reason = linked instanceof Error ? linked.message : `HTTP ${linked.status}`;
    return { failure: `${pdfUrl}: ${reason}` };
  }
  const bytes = new Uint8Array(await linked.arrayBuffer());
  if (!isPdf(bytes)) {
    return { failure: `${pdfUrl} serves no PDF` };
  }
  const titleHint = tags.citationTitle.trim() || tags.title.trim() || urlFilename(pdfUrl);
  return {
    upload: {
      pdf: new File([bytes], urlFilename(pdfUrl)),
      pdf_url: pdfUrl,
      source_url: url,
      title_hint: titleHint,
    },
  };
}

// The PDFs directly inside FOLDER, by name, as uploads with `file:` URLs for provenance.
export async function pdfsInFolder(folder: string): Promise<CaptureUpload[]> {
  const entries = await readdir(folder, { withFileTypes: true });
  const pdfs = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
    .map((entry) => entry.name)
    .sort();
  const folderUrl = pathToFileURL(`${folder}/`).href;
  const uploads = await Promise.all(
    pdfs.map(async (name) => {
      const path = join(folder, name);
      const bytes = await Bun.file(path).bytes();
      const upload: CaptureUpload = {
        pdf: new File([bytes], name),
        pdf_url: pathToFileURL(path).href,
        source_url: folderUrl,
        title_hint: name.slice(0, -".pdf".length),
      };
      return { upload, pdf: isPdf(bytes) };
    }),
  );
  return uploads.filter((entry) => entry.pdf).map((entry) => entry.upload);
}
