// The real configured assistant reads a stored PDF that has no structured extraction and answers
// with text present only on its first page. This uses a private bucket and assistant server; it
// does not open or change a chat in the provisioned app. The configured provider must be reachable.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
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
          .object({ type: z.string(), text: z.string().optional() })
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

test("the assistant answers from the raw PDF without a structured extraction", async () => {
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
    form.set("pdf_url", "https://www.math.example.edu/~author/long-notes.pdf");
    form.set("title_hint", "Long Notes");
    expect(
      (await app.request("/capture-bytes", { method: "POST", body: form }))
        .status,
    ).toBe(200);

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
    const request = (path: string, init?: RequestInit) =>
      fetch(`${assistantOrigin}${path}`, {
        ...init,
        headers: { ...init?.headers, Authorization: authorization },
      });

    const prompt = await request(`/api/session/${sessionID}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Read the original PDF named in AGENTS.md. There is no structured extraction. Quote the full sentence on page 1 that begins 'The lattice'.",
      }),
    });
    expect(prompt.status).toBe(200);
    const waited = await request(
      `/api/experimental/session/${sessionID}/wait`,
      {
        method: "POST",
        signal: AbortSignal.timeout(180_000),
      },
    );
    expect(waited.status).toBe(204);
    const messages = await request(
      `/api/session/${sessionID}/message?type=assistant&order=desc&limit=1`,
    );
    expect(messages.status).toBe(200);
    const answer = MessagesSchema.parse(await messages.json())
      .data.flatMap((message) => message.content)
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
    console.info("raw-PDF assistant answer", answer);

    expect(answer).toContain("Z1");
    expect(answer).toContain("determinant 1");
    expect(answer).toContain("norm 1");
  } finally {
    await app.stop();
  }
});
