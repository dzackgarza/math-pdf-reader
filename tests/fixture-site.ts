// A local site serving the capture fixture cases. Every page sets a per-run session cookie
// and every PDF route refuses requests without it, so a capture that does not send the
// tab's cookies fails. Requests are logged for the left-alone cases.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { z } from "zod";

const fixtures = join(import.meta.dir, "fixtures");
const lectureNotes = new Uint8Array(readFileSync(join(fixtures, "lecture-notes.pdf")));
const problemSet = new Uint8Array(readFileSync(join(fixtures, "problem-set.pdf")));

// The PDF served at ROUTE: a fixture with a comment after its end naming the route, so no two
// routes serve the same bytes (the store keeps identical bytes as one item).
function servedAt(route: string, fixture: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  return new Uint8Array([...fixture, ...new TextEncoder().encode(`% served at ${route}\n`)]);
}

// A PDF route: the bytes a browser receives, the headers they come with, whether they are sent
// gzip-encoded, whether the route answers only its first request (a signed or single-use
// URL, which refuses every later request with 403), and whether it answers without the
// session (an open-access PDF, as arXiv serves them).
type Pdf = {
  bytes: Uint8Array<ArrayBuffer>;
  headers: Record<string, string>;
  gzip: boolean;
  singleUse: boolean;
  open: boolean;
};

const servedAs = (headers: Record<string, string>, bytes: Uint8Array<ArrayBuffer>): Pdf => ({
  bytes,
  headers,
  gzip: false,
  singleUse: false,
  open: false,
});

const inline = (bytes: Uint8Array<ArrayBuffer>): Pdf =>
  servedAs({ "Content-Type": "application/pdf" }, bytes);

// A signed URL whose query is longer than any regular expression Chrome's rules accept (their
// compiled form must be under 2 KB).
export const LONG_FRAME_PDF = `/frames/signed.pdf?signature=${"a".repeat(4000)}`;

const pdfs: Record<string, Pdf> = {
  // arXiv serves `/pdf/<id>` without a `.pdf` suffix.
  "/pdf/2401.00001": inline(servedAt("/pdf/2401.00001", problemSet)),
  "/notes/lecture-notes.pdf": inline(servedAt("/notes/lecture-notes.pdf", lectureNotes)),
  "/notes/survey.pdf": inline(servedAt("/notes/survey.pdf", problemSet)),
  "/download?id=problem-set": {
    bytes: servedAt("/download?id=problem-set", problemSet),
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="problem-set.pdf"',
    },
    gzip: false,
    singleUse: false,
    open: false,
  },
  "/embedded/figure.pdf": inline(servedAt("/embedded/figure.pdf", lectureNotes)),
  "/frames/preview.pdf": inline(servedAt("/frames/preview.pdf", problemSet)),
  "/frames/appendix.pdf": inline(servedAt("/frames/appendix.pdf", lectureNotes)),
  "/frames/chapter.pdf": inline(servedAt("/frames/chapter.pdf", lectureNotes)),
  [LONG_FRAME_PDF]: inline(servedAt("/frames/signed.pdf", problemSet)),
  // A DOI resolves by redirect to the publisher's PDF URL.
  "/articles/redirected.pdf": inline(servedAt("/articles/redirected.pdf", problemSet)),
  "/notes/fragment.pdf": inline(servedAt("/notes/fragment.pdf", lectureNotes)),
  // `%E9` is é in Latin-1 and no valid UTF-8 escape.
  "/notes/caf%E9.pdf": inline(servedAt("/notes/caf%E9.pdf", problemSet)),
  "/notes/compressed.pdf": {
    ...inline(servedAt("/notes/compressed.pdf", lectureNotes)),
    gzip: true,
  },
  "/once/ticket.pdf": { ...inline(servedAt("/once/ticket.pdf", problemSet)), singleUse: true },
  "/open/pdf/2402.00002": { ...inline(servedAt("/open/pdf/2402.00002", lectureNotes)), open: true },
  "/notes/typed.pdf": inline(servedAt("/notes/typed.pdf", lectureNotes)),
  "/notes/held.pdf": inline(servedAt("/notes/held.pdf", problemSet)),
  // No page links or frames it: only a page that frames the capture page itself names it.
  "/private/statement.pdf": inline(servedAt("/private/statement.pdf", problemSet)),
  // Amazon S3's default type for an object uploaded without one.
  "/objects/scan.pdf": servedAs(
    { "Content-Type": "binary/octet-stream" },
    servedAt("/objects/scan.pdf", problemSet),
  ),
  "/files/handout.pdf": servedAs(
    { "Content-Type": "application/force-download" },
    servedAt("/files/handout.pdf", lectureNotes),
  ),
  "/files/untyped.pdf": servedAs({}, servedAt("/files/untyped.pdf", problemSet)),
  // The next two carry no `.pdf` in the path: only the type says PDF.
  "/papers/legacy": servedAs(
    { "Content-Type": "application/x-pdf" },
    servedAt("/papers/legacy", lectureNotes),
  ),
  // Whitespace before the parameters, which RFC 9110 allows.
  "/papers/spaced": servedAs(
    { "Content-Type": "application/pdf ;version=1.7" },
    servedAt("/papers/spaced", problemSet),
  ),
};

const redirects: Record<string, string> = {
  "/doi/10.5555/redirected": "/articles/redirected.pdf",
};

const pages: Record<string, { title: string; head?: string; body: string }> = {
  // An abstract page that names its open-access PDF with Highwire tags, as arXiv does.
  "/open/abs/2402.00002": {
    title: "[2402.00002] Even unimodular lattices",
    head: '<meta name="citation_title" content="Even unimodular lattices"><meta name="citation_pdf_url" content="/open/pdf/2402.00002">',
    body: "<h1>Even unimodular lattices</h1>",
  },
  "/abs/2401.00001": {
    title: "[2401.00001] Sphere packing in dimension 8",
    body: '<a id="pdf" href="/pdf/2401.00001">Sphere packing in dimension 8 (PDF)</a>',
  },
  "/teaching.html": {
    title: "Teaching",
    body: '<a id="pdf" href="/notes/lecture-notes.pdf">Lecture notes on lattices</a>',
  },
  "/reading-list.html": {
    title: "Reading list",
    body: '<a id="pdf" href="/notes/survey.pdf" target="_blank">A survey of lattices</a>',
  },
  "/downloads.html": {
    title: "Downloads",
    body: '<a id="pdf" href="/download?id=problem-set">Problem set 3</a>',
  },
  "/embed.html": {
    title: "Figure",
    body: '<embed src="/embedded/figure.pdf" type="application/pdf" width="320" height="240">',
  },
  "/form.html": {
    title: "Generate a certificate",
    body: '<form method="post" action="/generate"><button id="generate">Generate</button></form>',
  },
  "/frame-small.html": {
    title: "Preview",
    body: '<iframe src="/frames/preview.pdf" width="320" height="240"></iframe>',
  },
  "/frame-large.html": {
    title: "Chapter",
    body: '<iframe src="/frames/chapter.pdf" style="width: 1000px; height: 700px"></iframe>',
  },
  "/frame-small-signed.html": {
    title: "Signed preview",
    body: `<iframe src="${LONG_FRAME_PDF}" width="320" height="240"></iframe>`,
  },
  "/frames-small-pair.html": {
    title: "Previews",
    body:
      '<iframe src="/frames/preview.pdf" width="320" height="240"></iframe>' +
      '<iframe src="/frames/appendix.pdf" width="320" height="240"></iframe>',
  },
  "/citation.html": {
    title: "Citation",
    body: '<a id="pdf" href="/doi/10.5555/redirected">Full text via DOI</a>',
  },
  "/fragment.html": {
    title: "Chapter two",
    body: '<a id="pdf" href="/notes/fragment.pdf#page=2">Chapter two, page 2</a>',
  },
  "/latin1.html": {
    title: "Café",
    body: '<a id="pdf" href="/notes/caf%E9.pdf">Café notes</a>',
  },
  "/compressed.html": {
    title: "Compressed",
    body: '<a id="pdf" href="/notes/compressed.pdf">Compressed notes</a>',
  },
  "/ticket.html": {
    title: "Ticket",
    body: '<a id="pdf" href="/once/ticket.pdf">Single-use ticket</a>',
  },
  "/held.html": {
    title: "Held",
    body: '<a id="pdf" href="/notes/held.pdf">Notes whose capture outlives the worker</a>',
  },
  "/scan.html": {
    title: "Scan",
    body: '<a id="pdf" href="/objects/scan.pdf">Scanned chapter</a>',
  },
  "/handout.html": {
    title: "Handout",
    body: '<a id="pdf" href="/files/handout.pdf">Handout</a>',
  },
  "/untyped.html": {
    title: "Untyped",
    body: '<a id="pdf" href="/files/untyped.pdf">Untyped notes</a>',
  },
  "/legacy.html": {
    title: "Legacy",
    body: '<a id="pdf" href="/papers/legacy">Legacy paper</a>',
  },
  "/spaced.html": {
    title: "Spaced",
    body: '<a id="pdf" href="/papers/spaced">Spaced paper</a>',
  },
};

// The bytes the site serves at the PDF route PATH.
export function pdfBytes(path: string): Uint8Array<ArrayBuffer> {
  const pdf = pdfs[path];
  if (pdf === undefined) {
    throw new Error(`the fixture site serves no PDF at ${path}`);
  }
  return pdf.bytes;
}

export type LoggedRequest = { method: string; path: string };

type Answer = { status: number; headers: Record<string, string>; body: Uint8Array | string };

// node:http, not Bun.serve: Bun.serve gives every response a Content-Type, and the site must
// be able to send a PDF without one.
export async function startFixtureSite() {
  const session = crypto.randomUUID();
  const requests: LoggedRequest[] = [];
  // PDF routes already answered.
  const used = new Set<string>();
  // Set once the server listens, before it answers anything.
  let origin = "";
  const text = (status: number, body: string): Answer => ({
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    body,
  });
  const answer = (method: string, path: string, cookie: string | undefined): Answer => {
    requests.push({ method, path });
    const page = pages[path];
    if (page !== undefined) {
      return {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Set-Cookie": `fixture_session=${session}; Path=/`,
        },
        body: `<!doctype html><html><head><title>${page.title}</title>${page.head ?? ""}</head><body>${page.body}</body></html>`,
      };
    }
    if (cookie !== `fixture_session=${session}` && pdfs[path]?.open !== true) {
      return text(403, "session cookie required");
    }
    if (method === "POST" && path === "/generate") {
      return { status: 200, headers: { "Content-Type": "application/pdf" }, body: lectureNotes };
    }
    const redirect = redirects[path];
    if (redirect !== undefined) {
      return { status: 302, headers: { Location: `${origin}${redirect}` }, body: "" };
    }
    const pdf = pdfs[path];
    if (method !== "GET" || pdf === undefined) {
      return text(404, "not found");
    }
    if (pdf.singleUse && used.has(path)) {
      return text(403, "this link has been used");
    }
    used.add(path);
    if (pdf.gzip) {
      return {
        status: 200,
        headers: { ...pdf.headers, "Content-Encoding": "gzip" },
        body: Bun.gzipSync(pdf.bytes),
      };
    }
    return { status: 200, headers: pdf.headers, body: pdf.bytes };
  };
  const server = createServer((request, response) => {
    const { status, headers, body } = answer(
      z.string().parse(request.method),
      z.string().parse(request.url),
      request.headers.cookie,
    );
    response.writeHead(status, { ...headers, "Content-Length": Buffer.byteLength(body) });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = z.object({ port: z.number() }).parse(server.address());
  origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    requests,
    stop: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
