// The send action: create the bucket item in Zotero, set its URL and access date, attach the
// stored PDF and the extraction Markdown, and record the Zotero key in the filing document
// after each step. Removing the item from the bucket is a separate request that only an item
// whose PDF reached Zotero accepts.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Mutex } from "async-mutex";
import type { Context, Hono } from "hono";
import { REPO_ROOT } from "./config";
import type { LibraryState } from "./library";
import type {
  ApiErrorKind,
  Extraction,
  SendResponse,
  SendSource,
  SendStep,
  SendStepDone,
  ZoteroRecord,
  ZoteroStatus,
} from "./libraryContract";
import type { IndexedItem } from "./libraryIndex";
import { setZoteroRecord } from "./organization";
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

function apiError(c: Context, status: 404 | 409 | 502, kind: ApiErrorKind, message: string) {
  return c.json({ error: { kind, message } }, status);
}

type ResolverFailure = Extract<Resolution, { status: "failed" }>;

function lastLine(text: string): string {
  const lines = text.trim().split("\n");
  return lines[lines.length - 1] ?? "";
}

export function sendRoutes(app: Hono, state: LibraryState, root: string, zotero: ZoteroWriteApi) {
  // One send or removal at a time, so two clicks never create two Zotero items.
  const sends = new Mutex();

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
    const bibtex =
      resolution.status === "resolved"
        ? resolution.bibtex
        : manuscriptBibtex(provenance.title_hint);
    const itemKey = await zotero.importBibtex(bibtex);
    return { itemKey, sentAt: new Date().toISOString(), source, steps: [] };
  }

  async function perform(step: SendStep, itemKey: string, indexed: IndexedItem) {
    const { key, provenance } = indexed.stored;
    const done: Record<SendStep, () => Promise<SendStepDone>> = {
      fields: async () => {
        await zotero.setUrlAndAccessDate(itemKey, provenance.source_url, provenance.captured_at);
        return { step: "fields" };
      },
      pdf: async () => ({
        step: "pdf",
        attachmentKey: await zotero.attachBytes(
          itemKey,
          `${key}.pdf`,
          "Full Text PDF",
          await readFile(indexed.path),
        ),
      }),
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
        const message = `resolver ${created.plugin_id} failed on ${created.identifier} (exit ${created.exit_code}): ${lastLine(created.stderr)}`;
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
      const response: SendResponse = {
        itemKey: record.itemKey,
        created: existing === undefined,
        performed,
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
      const record = (await state.organizations.read()).items[key]?.zotero;
      if (record === undefined || !record.steps.some((step) => step.step === "pdf")) {
        const message = `${key} has not reached Zotero with its PDF; only a sent item leaves the bucket`;
        return apiError(c, 409, "not_sent", message);
      }
      await removeStored(root, key);
      return c.json(await state.payloadOf(await state.organizations.read()));
    }),
  );
}
