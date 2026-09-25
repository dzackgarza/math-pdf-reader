// A local site serving the capture fixture cases. Every page sets a per-run session cookie
// and every PDF route refuses requests without it, so a capture that does not send the
// tab's cookies fails. Requests are logged for the left-alone cases.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fixtures = join(import.meta.dir, "fixtures");
const lectureNotes = new Uint8Array(readFileSync(join(fixtures, "lecture-notes.pdf")));
const problemSet = new Uint8Array(readFileSync(join(fixtures, "problem-set.pdf")));

// The PDF served at ROUTE: a fixture with a comment after its end naming the route, so no two
// routes serve the same bytes (the store keeps identical bytes as one item).
function servedAt(route: string, fixture: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  return new Uint8Array([...fixture, ...new TextEncoder().encode(`% served at ${route}\n`)]);
}

type Pdf = { bytes: Uint8Array<ArrayBuffer>; headers: Record<string, string> };

const inline = (bytes: Uint8Array<ArrayBuffer>): Pdf => ({
  bytes,
  headers: { "Content-Type": "application/pdf" },
});

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
  },
  "/embedded/figure.pdf": inline(servedAt("/embedded/figure.pdf", lectureNotes)),
  "/frames/preview.pdf": inline(servedAt("/frames/preview.pdf", problemSet)),
  "/frames/chapter.pdf": inline(servedAt("/frames/chapter.pdf", lectureNotes)),
};

const pages: Record<string, { title: string; body: string }> = {
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

export function startFixtureSite() {
  const session = crypto.randomUUID();
  const requests: LoggedRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const path = `${url.pathname}${url.search}`;
      requests.push({ method: request.method, path });
      const page = pages[path];
      if (page !== undefined) {
        return new Response(
          `<!doctype html><html><head><title>${page.title}</title></head><body>${page.body}</body></html>`,
          {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Set-Cookie": `fixture_session=${session}; Path=/`,
            },
          },
        );
      }
      if (request.headers.get("cookie") !== `fixture_session=${session}`) {
        return new Response("session cookie required", { status: 403 });
      }
      if (request.method === "POST" && path === "/generate") {
        return new Response(lectureNotes, { headers: { "Content-Type": "application/pdf" } });
      }
      const pdf = pdfs[path];
      if (request.method !== "GET" || pdf === undefined) {
        return new Response("not found", { status: 404 });
      }
      return new Response(pdf.bytes, { headers: pdf.headers });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
}
