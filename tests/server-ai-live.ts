// The real provider inspects the stored PDF, then reads a new app-produced extraction.
// This uses a private bucket and assistant server; it does not open or change a chat in the
// provisioned app. The configured provider must be reachable.
import { expect, test } from "bun:test";
import { createHash, randomInt, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { LibraryPayloadSchema } from "../src/contract/library";
import { AiSessionSchema } from "../src/contract/ai";
import { CONFIG_PATH, loadAppConfig } from "../src/contract/config";
import { ExtractionOutcomeSchema } from "../src/contract/extraction";
import { closedPortUrl, serveBucket } from "./bucket";

const MessagesSchema = z.object({
  data: z.array(
    z.object({
      content: z.array(
        z
          .object({
            type: z.string(),
            text: z.string().optional(),
            name: z.string().optional(),
            state: z
              .object({
                status: z.string(),
                content: z.array(z.object({ text: z.string().optional() })).optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough(),
      ),
    }),
  ),
});

function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = server.port;
  server.stop(true);
  if (port === undefined)
    throw new Error("the temporary listener did not bind a port");
  return port;
}

test("the assistant inspects the original PDF with the shell and discovers a new artifact in the same chat", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-ai-live-"));
  const config = loadAppConfig(CONFIG_PATH);
  const aiPort = freePort();
  config.ai.port = aiPort;
  const marker = `pdf-bucket-live-discovery-${randomUUID()}`;
  const passage = `The lattice $Z^2$ has determinant 1. Source verification: ${marker}`;
  const manifestPath = join(root, "extractions.json");
  writeFileSync(manifestPath, JSON.stringify({ plugins: [{
    id: "live-passage",
    name: "Live passage fixture",
    source_kind: "document_structure",
    authoritative: true,
    command: ["sh", join(import.meta.dir, "fixtures/plugins/extractor.sh"),
      "record", "$pdf", "$output", "# Lecture 2", passage],
    accepted_inputs: [{ kind: "pdf", id: "pdf", label: "PDF", limits: [] }],
  }] }));
  const app = await serveBucket({
    root,
    zoteroUrl: closedPortUrl(),
    extractionsManifest: manifestPath,
    config,
    // The private assistant links the user's provider logins. Its own data remains under the
    // scratch bucket's index-export directory.
    env: { XDG_DATA_HOME: join(process.env.HOME!, ".local", "share") },
  });
  try {
    const catalogNumber = String(randomInt(100000, 1000000));
    const fixtures = join(import.meta.dir, "fixtures");
    const scan = Bun.spawnSync([
      join(import.meta.dir, "../.venv/bin/python"), join(fixtures, "assistant-scan.py"),
      join(fixtures, "long-notes.pdf"), catalogNumber,
    ]);
    expect({ status: scan.exitCode, stderr: scan.stderr.toString() }).toEqual({ status: 0, stderr: "" });
    const form = new FormData();
    form.set(
      "pdf",
      new File(
        [new Uint8Array(scan.stdout)],
        "long-notes.pdf",
        {
          type: "application/pdf",
        },
      ),
    );
    form.set(
      "pdf_url",
      "https://www.math.example.edu/~author/long-notes.pdf",
    );
    form.set("title_hint", "Long Notes");
    expect(
      (await app.request("/capture-bytes", { method: "POST", body: form }))
        .status,
    ).toBe(200);
    expect((await app.request("/api/ai/text/long-notes")).status).toBe(404);

    const opened = await app.request("/api/ai/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "long-notes" }),
    });
    expect(opened.status).toBe(200);
    const addresses = AiSessionSchema.parse(await opened.json());
    const assistantOrigin = new URL(addresses.pairUrl).origin;
    const sessionID = addresses.sessionUrl.split("/session/").at(-1)!;
    const password = readFileSync(
      join(dirname(app.indexExport), "ai/password"),
      "utf8",
    ).trim();
    const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    const assistantRequest = (path: string, init?: RequestInit) =>
      fetch(`${assistantOrigin}${path}`, {
        ...init,
        headers: { ...init?.headers, Authorization: authorization },
      });

    async function ask(text: string) {
      const prompt = await assistantRequest(
        `/api/session/${sessionID}/prompt`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        },
      );
      expect(prompt.status).toBe(200);
      const waited = await assistantRequest(
        `/api/experimental/session/${sessionID}/wait`,
        {
          method: "POST",
          signal: AbortSignal.timeout(300_000),
        },
      );
      expect(waited.status).toBe(204);
      const messages = await assistantRequest(
        `/api/session/${sessionID}/message?type=assistant&order=desc&limit=1`,
      );
      expect(messages.status).toBe(200);
      return MessagesSchema.parse(await messages.json()).data.flatMap(
        (message) => message.content,
      );
    }

    const pdf = join(root, "long-notes", "long-notes.pdf");
    const expectedHash = createHash("sha256").update(readFileSync(pdf)).digest("hex");
    const pdfAnswer = await ask([
      "Inspect the original PDF using your shell. Report its SHA-256.",
      "Read the scanned cover using pdftoppm -f 1 -l 1 -scale-to 1800 -png long-notes.pdf | tesseract stdin stdout.",
      "Report the printed catalog number and a line labeled Signer with the name you can read.",
      "Use only the scanned cover for this question. If it labels the signature as redacted, enter UNREADABLE and explain the limitation.",
    ].join(" "));
    const coverAnswer = pdfAnswer.filter((part) => part.type === "text").map((part) => part.text).join(" ");
    expect(coverAnswer).toContain(expectedHash);
    expect(coverAnswer).toContain(catalogNumber);
    expect(coverAnswer.replaceAll("*", "")).toMatch(/Signer\s*[:|]\s*\x60?UNREADABLE/i);
    expect(coverAnswer).toMatch(/redact|obscur|black(?:ed| box| bar| rectangle)/i);

    const pageReport = await app.request("/api/items/long-notes/reading", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page: 2, pages: 210 }),
    });
    expect(pageReport.status).toBe(200);
    const context = await (await app.request("/api/ai/view/long-notes")).text();
    expect(context).toContain("page 2");
    expect(context).toContain("lattice Z2");
    const accession = randomUUID();
    writeFileSync(join(root, "long-notes", "catalog.json"), JSON.stringify({ accession }));
    const paper = join(root, "long-notes");
    const markdownPath = join(paper, "long-notes.md");
    expect(existsSync(markdownPath)).toBe(false);
    const extraction = await app.request("/api/items/long-notes/extractions/live-passage", {
      method: "POST",
    });
    expect(extraction.status).toBe(200);
    const outcome = ExtractionOutcomeSchema.parse(await extraction.json());
    expect(outcome).toMatchObject({ status: "succeeded", key: "long-notes",
      plugin_id: "live-passage", markdown: { path: "long-notes.md" } });
    const published = readFileSync(markdownPath, "utf8");
    expect(published).toContain(passage);
    expect(outcome.status).toBe("succeeded");
    if (outcome.status === "succeeded") {
      expect(outcome.markdown.sha256).toBe(createHash("sha256").update(published).digest("hex"));
    }
    const library = LibraryPayloadSchema.parse(await (await app.request("/api/library")).json());
    expect(library.items.find((item) => item.id === "long-notes")?.extraction).toMatchObject({
      status: "extracted", sourceKind: "document_structure", authoritative: true,
    });
    const discoveryParts = await ask(
      "Find the new Markdown in this paper directory. Use the reader's current page to locate the passage. Use a shell command to read the Markdown. Return the lattice notation exactly as written in that file and its source verification value. Also report the accession identifier from the separate catalog metadata.",
    );
    const discoveryAnswer = discoveryParts
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
    const transcript = await assistantRequest(
      `/api/session/${sessionID}/message?type=assistant&order=desc&limit=50`,
    );
    expect(transcript.status).toBe(200);
    const toolCalls = MessagesSchema.parse(await transcript.json())
      .data.flatMap((message) => message.content)
      .filter((part) => part.type === "tool");
    const shellReads = toolCalls.filter((part) =>
      part.name === "shell" && part.state?.status === "completed" &&
      part.state.content?.some((block) => block.text?.includes(passage))
    );
    expect(discoveryAnswer).toContain("Z^2");
    expect(discoveryAnswer).toContain(marker);
    expect(discoveryAnswer).toContain(accession);
    expect(shellReads.length).toBeGreaterThan(0);
  } finally {
    try {
      await app.stop();
    } finally {
      for (const path of [root, ...app.temporaryPaths]) {
        rmSync(path, { recursive: true, force: true });
      }
    }
  }
});
