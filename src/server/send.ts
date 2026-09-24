// The send action: create the bucket item in Zotero, set its URL and access date, attach the
// stored PDF and the extraction Markdown, and record the Zotero key in the filing document
// after each step. Once every step is done the item leaves the bucket, since Zotero holds it
// now, unless a collection holding it (or holding a collection that holds it) keeps its items
// offline.
// Deleting an item moves its PDF to the desktop trash and drops its filing.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Mutex } from "async-mutex";
import type { Context, Hono } from "hono";
import { arxivId } from "../resolvers/arxivId";
import { REPO_ROOT } from "./config";
import type { Library, LibraryState } from "./library";
import {
  type ApiErrorKind,
  collectionSubtree,
  type Extraction,
  type SendResponse,
  type SendSource,
  type SendStep,
  type SendStepDone,
  type ZoteroRecord,
  type ZoteroStatus,
} from "./libraryContract";
import type { IndexedItem } from "./libraryIndex";
import { type Organization, removeItem, setZoteroRecord } from "./organization";
import { type Resolution, removeStored, resolveItem } from "./store";
import type { ZoteroWriteApi } from "./zotero";

export const RESOLVERS_MANIFEST = join(REPO_ROOT, "plugins/manifests/resolvers.json");

// The Zotero item for a PDF with no identifier: a manuscript (BibTeX `@unpublished`, which
// Zotero's BibTeX import maps to its manuscript type) that carries only the title; the URL and
// access date follow as the `fields` step. Zotero's import keeps a braced value as written
// apart from LaTeX markup, and a LaTeX-escaping writer's output does not survive it
// (`\textunderscore{}` arrives as "‗"), so the title goes in as written with only its braces
// escaped: BibTeX ends a value at its balancing brace, and Zotero reads `\{` back as `{`.
export function manuscriptBibtex(title: string): string {
  const value = title.replace(/[{}]/g, (brace) => `\\${brace}`);
  return `@unpublished{bucket,\n  title = {${value}},\n}\n`;
}

function stepsOwed(extraction: Extraction): SendStep[] {
  return extraction.status === "extracted" ? ["fields", "pdf", "markdown"] : ["fields", "pdf"];
}

function pendingSteps(record: ZoteroRecord, extraction: Extraction): SendStep[] {
  const done = new Set(record.steps.map((step) => step.step));
  return stepsOwed(extraction).filter((step) => !done.has(step));
}

export function zoteroStatus(
  record: ZoteroRecord | undefined,
  extraction: Extraction,
): ZoteroStatus {
  if (record === undefined) {
    return { status: "unsent" };
  }
  return { status: "sent", record, pending: pendingSteps(record, extraction) };
}

// Whether a Keep offline collection holds the item, directly or through a subcollection.
export function keptOffline(org: Organization, key: string): boolean {
  const filed = new Set(org.items[key]?.collections ?? []);
  return org.collections
    .filter((collection) => collection.keepOffline)
    .some((collection) =>
      [...collectionSubtree(org.collections, collection.id)].some((id) => filed.has(id)),
    );
}

function apiError(c: Context, status: 404 | 409 | 502, kind: ApiErrorKind, message: string) {
  return c.json({ error: { kind, message } }, status);
}

type ResolverFailure = Extract<Resolution, { status: "failed" }>;

export function sendRoutes(
  app: Hono,
  state: LibraryState,
  root: string,
  zotero: ZoteroWriteApi,
  library: Library,
) {
  // One send or removal at a time, so two clicks never create two Zotero items.
  const sends = new Mutex();

  const remove = async (key: string) => {
    await removeStored(root, key);
    const organization = await state.organizations.update((org) => removeItem(org, key));
    library.removed([key]);
    return organization;
  };

  const save = (key: string, record: ZoteroRecord) =>
    state.organizations.update((org) =>
      setZoteroRecord(org, key, record, new Date().toISOString()),
    );

  async function create(indexed: IndexedItem): Promise<ZoteroRecord | ResolverFailure> {
    const { key, provenance } = indexed.stored;
    const resolution = await resolveItem(root, key, RESOLVERS_MANIFEST);
    if (resolution.status === "failed") {
      return resolution;
    }
    const source: SendSource =
      resolution.status === "resolved"
        ? { kind: "resolver", pluginId: resolution.plugin_id, identifier: resolution.identifier }
        : { kind: "manuscript" };
    const itemKey = await createZoteroItem(resolution, provenance.title_hint);
    return { itemKey, sentAt: new Date().toISOString(), source, steps: [] };
  }

  // Zotero's BibTeX import maps `@misc` to `document` and maps no entry type to `preprint`, so
  // an arXiv item goes through Zotero's own arXiv translator instead; the resolver has already
  // confirmed the id against arXiv. DOI, ISBN and zbMATH BibTeX map to their right types.
  function createZoteroItem(resolution: Resolution, title: string): Promise<string> {
    if (resolution.status === "resolved" && resolution.plugin_id === "arxiv") {
      return zotero.importByIdentifier(`arXiv:${arxivId(resolution.identifier)}`);
    }
    const bibtex = resolution.status === "resolved" ? resolution.bibtex : manuscriptBibtex(title);
    return zotero.importBibtex(bibtex);
  }

  async function perform(step: SendStep, itemKey: string, indexed: IndexedItem) {
    const { key, provenance } = indexed.stored;
    const done: Record<SendStep, () => Promise<SendStepDone>> = {
      fields: async () => {
        await zotero.setUrlAndAccessDate(itemKey, provenance.source_url, provenance.captured_at);
        return { step: "fields" };
      },
      // The captured PDF once: Zotero's own copy when its import downloaded the same bytes,
      // otherwise the bucket's stored file.
      pdf: async () => {
        const existing = await zotero.pdfWithHash(itemKey, provenance.original_sha256);
        if (existing.kind === "found") {
          return { step: "pdf", attachmentKey: existing.attachmentKey };
        }
        const bytes = await readFile(indexed.path);
        const attachmentKey = await zotero.attachBytes(
          itemKey,
          `${key}.pdf`,
          "Full Text PDF",
          bytes,
        );
        return { step: "pdf", attachmentKey };
      },
      // Named as the extraction loop names a Markdown child, which marks an item extracted.
      markdown: async () => ({
        step: "markdown",
        attachmentKey: await zotero.attachBytes(
          itemKey,
          `${itemKey}_extracted.md`,
          `${itemKey}_extracted.md`,
          await readFile(join(root, `${key}.md`)),
        ),
      }),
    };
    return done[step]();
  }

  app.post("/api/items/:key/zotero", (c) =>
    sends.runExclusive(async () => {
      const key = c.req.param("key");
      const indexed = await state.indexed(key);
      if (indexed === undefined) {
        return apiError(c, 404, "unknown_item", `no stored PDF has key ${key}`);
      }
      const existing = (await state.organizations.read()).items[key]?.zotero;
      const status = zoteroStatus(existing, indexed.extraction);
      if (status.status === "sent" && status.pending.length === 0) {
        const message = `${key} is already in Zotero as ${status.record.itemKey}`;
        return apiError(c, 409, "already_sent", message);
      }

      const created = existing === undefined ? await create(indexed) : existing;
      if ("status" in created) {
        const message = `resolver ${created.plugin_id} failed on ${created.identifier} (exit ${created.exit_code}): ${created.stderr.trim()}`;
        return apiError(c, 502, "resolver_failed", message);
      }
      await save(key, created);

      let record = created;
      const performed: SendStep[] = [];
      for (const step of pendingSteps(created, indexed.extraction)) {
        record = {
          ...record,
          steps: [...record.steps, await perform(step, record.itemKey, indexed)],
        };
        await save(key, record);
        performed.push(step);
      }
      const kept = keptOffline(await state.organizations.read(), key);
      if (!kept) {
        await remove(key);
      }
      const response: SendResponse = {
        itemKey: record.itemKey,
        created: existing === undefined,
        performed,
        kept,
      };
      return c.json(response);
    }),
  );

  app.delete("/api/items/:key", (c) =>
    sends.runExclusive(async () => {
      const key = c.req.param("key");
      if ((await state.indexed(key)) === undefined) {
        return apiError(c, 404, "unknown_item", `no stored PDF has key ${key}`);
      }
      return c.json(await state.payloadOf(await remove(key)));
    }),
  );
}
