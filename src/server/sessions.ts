// Reading sessions, kept in one JSON document under the bucket root beside the filing: a report
// replaces the stored session with its id, with the item as it stands now. Like the filing
// document, writes are serialized and land by rename.
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Hono } from "hono";
import { z } from "zod";
import { apiError, invalid, type LibraryState, parseBody } from "./library";
import {
  type ReadingSession,
  ReadingSessionReportSchema,
  ReadingSessionSchema,
} from "./libraryContract";

const SessionsSchema = z.strictObject({
  version: z.literal(1),
  sessions: z.array(ReadingSessionSchema),
});

type Sessions = z.infer<typeof SessionsSchema>;

class SessionStore {
  private queue: Promise<Sessions> = Promise.resolve({ version: 1, sessions: [] });

  constructor(private readonly path: string) {}

  async read(): Promise<Sessions> {
    if (!existsSync(this.path)) {
      return { version: 1, sessions: [] };
    }
    return SessionsSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
  }

  upsert(session: ReadingSession): Promise<Sessions> {
    const write = async () => {
      const current = await this.read();
      const others = current.sessions.filter((stored) => stored.id !== session.id);
      const next = SessionsSchema.parse({ ...current, sessions: [...others, session] });
      const partial = `${this.path}.partial`;
      await writeFile(partial, `${JSON.stringify(next, null, 2)}\n`);
      await rename(partial, this.path);
      return next;
    };
    this.queue = this.queue.then(write, write);
    return this.queue;
  }
}

export function sessionRoutes(app: Hono, state: LibraryState, root: string) {
  const store = new SessionStore(join(root, "reading-sessions.json"));

  app.get("/api/reading-sessions", async (c) => c.json((await store.read()).sessions));

  app.post("/api/reading-sessions", async (c) => {
    const body = await parseBody(c, ReadingSessionReportSchema);
    if (!body.success) {
      return invalid(c, body.error);
    }
    const indexed = await state.indexed(body.data.key);
    if (indexed === undefined) {
      return apiError(c, 404, "unknown_item", `no stored PDF has key ${body.data.key}`);
    }
    const { title, authors, year, abstract, provenance } = indexed.stored;
    const item = { title: title.text, authors, year, abstract, sourceUrl: provenance.source_url };
    await store.upsert({ ...body.data, item });
    return c.json({ id: body.data.id });
  });
}
