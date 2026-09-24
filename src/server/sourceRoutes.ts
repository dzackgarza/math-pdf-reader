// Routes for an item's sources: its mirrors, checking its PDF URL and mirrors, and rebuilding
// a PDF the store has lost.
import { Semaphore } from "async-mutex";
import type { Context, Hono } from "hono";
import { MirrorRequestSchema, type RebuildOutcome } from "../contract/library";
import { recoverable } from "./indexExport";
import { apiError, invalid, type Library, type LibraryState, now, parseBody } from "./library";
import type { IndexedItem } from "./libraryIndex";
import { addMirror, recordSourceChecks, removeMirror } from "./organization";
import { checkSource, type DownloadSettings, rebuildItem } from "./sources";

export function sourceRoutes(
  app: Hono,
  state: LibraryState,
  root: string,
  settings: DownloadSettings,
  library: Library,
) {
  const downloads = new Semaphore(settings.concurrent_downloads);
  const unknownItem = (c: Context, key: string) =>
    apiError(c, 404, "unknown_item", `no stored PDF has key ${key}`);

  // Checks the PDF URL and every mirror, each download taking a slot of the shared limit.
  const verify = async (indexed: IndexedItem) => {
    const { key, provenance } = indexed.stored;
    const check = (url: string) =>
      downloads.runExclusive(() => checkSource(url, provenance.original_sha256, settings));
    const filing = (await state.organizations.read()).items[key];
    const mirrors = filing === undefined ? [] : filing.mirrors.map((mirror) => mirror.url);
    const [sourceCheck, mirrorChecks] = await Promise.all([
      check(provenance.pdf_url),
      Promise.all(mirrors.map(async (url) => [url, await check(url)] as const)),
    ]);
    const byUrl = new Map(mirrorChecks);
    await state.organizations.update((org) =>
      recordSourceChecks(org, key, provenance.captured_at, sourceCheck, byUrl),
    );
  };

  app.post("/api/items/:key/verify", async (c) => {
    const key = c.req.param("key");
    const indexed = await state.indexed(key);
    if (indexed === undefined) {
      return unknownItem(c, key);
    }
    await verify(indexed);
    return c.json(await state.payloadOf(await state.organizations.read()));
  });

  app.post("/api/verify", async (c) => {
    await Promise.all((await state.index.items()).map(verify));
    return c.json(await state.payloadOf(await state.organizations.read()));
  });

  app.post("/api/items/:key/mirrors", async (c) => {
    const key = c.req.param("key");
    const body = await parseBody(c, MirrorRequestSchema);
    if (!body.success) {
      return invalid(c, body.error);
    }
    if (!(await state.isStored(key))) {
      return unknownItem(c, key);
    }
    return state.change(c, (org) => addMirror(org, key, body.data.url, now()));
  });

  app.delete("/api/items/:key/mirrors", async (c) => {
    const key = c.req.param("key");
    const url = c.req.query("url");
    const filing = (await state.organizations.read()).items[key];
    if (url === undefined || !filing?.mirrors.some((mirror) => mirror.url === url)) {
      return apiError(c, 404, "unknown_mirror", `item ${key} has no mirror ${url}`);
    }
    return state.change(c, (org) => removeMirror(org, key, url, now()));
  });

  const rebuild = async (key: string): Promise<RebuildOutcome | null> => {
    const found = (await state.missing()).find((entry) => entry.item.key === key);
    if (found === undefined) {
      return null;
    }
    const outcome = await rebuildItem(root, recoverable(found.item), settings);
    if (outcome.status === "restored") {
      library.stored();
    }
    return outcome;
  };

  app.post("/api/items/:key/rebuild", async (c) => {
    const key = c.req.param("key");
    const outcome = await rebuild(key);
    if (outcome === null) {
      return apiError(c, 404, "unknown_item", `the index export lists no lost PDF with key ${key}`);
    }
    return c.json(outcome);
  });

  app.post("/api/rebuild", async (c) => {
    const keys = (await state.missing()).map(({ item }) => item.key);
    const outcomes = await Promise.all(
      keys.map((key) => downloads.runExclusive(() => rebuild(key))),
    );
    return c.json(outcomes);
  });
}
