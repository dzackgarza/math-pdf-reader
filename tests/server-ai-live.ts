// The real provider inspects the stored PDF, then reads a newly placed paper artifact.
// This uses a private bucket and assistant server; it does not open or change a chat in the
// provisioned app. The configured provider must be reachable.
import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { AiSessionSchema } from "../src/contract/ai";
import { CONFIG_PATH, loadAppConfig } from "../src/contract/config";
import { closedPortUrl, EXTRACTIONS_MANIFEST, serveBucket } from "./bucket";

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
                input: z.record(z.string(), z.unknown()),
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
  const app = await serveBucket({
    root,
    zoteroUrl: closedPortUrl(),
    extractionsManifest: EXTRACTIONS_MANIFEST,
    config,
    // The private assistant links the user's provider logins. Its own data remains under the
    // scratch bucket's index-export directory.
    env: { XDG_DATA_HOME: join(process.env.HOME!, ".local", "share") },
  });
  try {
    const bucketRequest = (path: string, init?: RequestInit) => app.request(path, init);
    const form = new FormData();
    form.set(
      "pdf",
      new File(
        [readFileSync(join(import.meta.dir, "fixtures/long-notes.pdf"))],
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
      (await bucketRequest("/capture-bytes", { method: "POST", body: form }))
        .status,
    ).toBe(200);
    expect((await bucketRequest("/api/ai/text/long-notes")).status).toBe(404);

    const opened = await bucketRequest("/api/ai/session", {
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
          signal: AbortSignal.timeout(180_000),
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
    const pdfAnswer = await ask("Use your shell in the paper directory to compute the SHA-256 of the original PDF. Return the digest.");
    expect(pdfAnswer.map((part) => part.text).join(" ")).toContain(expectedHash);

    const marker = `pdf-bucket-live-discovery-${randomUUID()}`;
    const artifact = join(
      root,
      "long-notes",
      "research-notes",
      "page-notes.md",
    );
    mkdirSync(dirname(artifact), { recursive: true });
    writeFileSync(artifact, `# Lecture 2\n\nSource verification: ${marker}\n`);
    const discoveryParts = await ask(
      "Find the new Markdown in this paper directory. Use a shell command to read its Lecture 2 passage and report the source verification value.",
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
      part.name === "bash" && part.state?.status === "completed" &&
      JSON.stringify(part.state).includes(marker)
    );
    expect(discoveryAnswer).toContain(marker);
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
