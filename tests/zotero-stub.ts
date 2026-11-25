// A loopback Zotero with the local write API, for tests that must not write to the user's own
// library. It answers in the shapes the write API documents (the addon's openapi.yaml, 3.11.2)
// and Zotero's local API serves, keeps the items and children the requests make, and records
// every request, so a test can read what Zotero would hold and what the bucket asked of it.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const VERSION = readFileSync(join(import.meta.dir, "fixtures/zotero/version.json"));
const ADDON_VERSION = "3.11.2";

export type ZoteroRequest = {
  method: string;
  // The path with its query, such as `/api/users/0/items/ABCD2345/children?itemType=annotation`.
  path: string;
  // The JSON body of a POST.
  body: Record<string, unknown> | null;
};

// A child of a Zotero item as Zotero's local API answers it, with the fields the tests read.
export type ZoteroChild = {
  key: string;
  data: {
    key: string;
    parentItem: string;
    itemType: "attachment" | "note";
    title: string;
    contentType?: string;
    filename?: string;
    note?: string;
  };
};

export type ZoteroItem = {
  key: string;
  url: string;
  collections: string[];
  fields: Record<string, string>;
  deleted: boolean;
};

// The row selected in Zotero's pane: a collection, a row that is not one (the library root, a
// saved search), or no row at all because no Zotero window is open.
export type Selection =
  | { kind: "collection"; key: string; name: string }
  | { kind: "library_root" }
  | { kind: "no_window" };

export type ZoteroStub = {
  url: string;
  requests: ZoteroRequest[];
  items: Map<string, ZoteroItem>;
  standalone: ZoteroChild[];
  selection: Selection;
  // Answers a request with Zotero's refusal instead of the stub's own answer; null lets the stub
  // answer. Set by a test to make Zotero fail one request.
  refuse: ((request: ZoteroRequest) => Response | null) | null;
  children(itemKey: string): ZoteroChild[];
  // Every write the bucket asked for: each `/write` operation and each `/attach`.
  writes(): string[];
  stop(): void;
};

const KEY_ALPHABET = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function success(operation: string, details: Record<string, unknown>, extra = {}): Response {
  return json(200, {
    success: true,
    operation,
    stage: "completed",
    version: ADDON_VERSION,
    details,
    ...extra,
  });
}

// The write API's error answer (`ErrorResponse`).
export function refusal(
  status: number,
  operation: string,
  error: string,
  request: unknown,
): Response {
  return json(status, {
    success: false,
    operation,
    stage: operation === "attach_file_to_item" ? "attach_endpoint" : "write_endpoint",
    error,
    details: { request },
    version: ADDON_VERSION,
  });
}

function contentType(fileName: string): string {
  if (fileName.endsWith(".pdf")) return "application/pdf";
  if (fileName.endsWith(".md")) return "text/markdown";
  return "application/octet-stream";
}

export function zoteroStub(): ZoteroStub {
  let next = 0;
  const key = () => {
    next += 1;
    let n = next;
    let text = "";
    for (let i = 0; i < 8; i += 1) {
      text = KEY_ALPHABET[n % KEY_ALPHABET.length] + text;
      n = Math.floor(n / KEY_ALPHABET.length);
    }
    return text;
  };
  const children = new Map<string, ZoteroChild[]>();
  const stub: ZoteroStub = {
    url: "",
    requests: [],
    items: new Map(),
    standalone: [],
    selection: { kind: "library_root" },
    refuse: null,
    children: (itemKey) => children.get(itemKey) ?? [],
    writes: () =>
      stub.requests.flatMap((request) => {
        if (request.method !== "POST") return [];
        if (request.path === "/attach") return ["attach"];
        return [String(request.body?.operation)];
      }),
    stop: () => server.stop(true),
  };
  const selectedCollection = (request: unknown): string | null | Response => {
    switch (stub.selection.kind) {
      case "collection":
        return stub.selection.key;
      case "library_root":
        return null;
      case "no_window":
        return refusal(
          409,
          String((request as { operation?: string }).operation ?? "attach_file_to_item"),
          "No Zotero window is open, so no collection is selected.",
          request,
        );
    }
  };
  const write = (body: Record<string, unknown>): Response => {
    const operation = String(body.operation);
    switch (operation) {
      case "get_selected_collection": {
        const selected = selectedCollection(body);
        if (selected instanceof Response) return selected;
        if (selected === null) {
          return refusal(404, operation, "No Collection selected.", body);
        }
        const name = stub.selection.kind === "collection" ? stub.selection.name : "";
        return success(operation, { collection_key: selected, collection_name: name });
      }
      case "import_from_url": {
        const url = String(body.url);
        const collections = (body.collection_keys as string[] | undefined) ?? [];
        const held = [...stub.items.values()].find((item) => item.url === url && !item.deleted);
        const item = held ?? {
          key: key(),
          url,
          collections: [],
          fields: {},
          deleted: false,
        };
        for (const collection of collections) {
          if (!item.collections.includes(collection)) item.collections.push(collection);
        }
        stub.items.set(item.key, item);
        return json(200, {
          success: true,
          operation,
          stage: "completed",
          version: ADDON_VERSION,
          item_key: item.key,
          item_id: next,
          method: "page_metadata",
          existing: held !== undefined,
          citation_key: `stub${next}`,
          details: {
            url,
            final_url: url,
            collection_keys: item.collections,
            translator: null,
            attempts: [{ method: "page_metadata", outcome: "identified", message: url }],
            attachment_failures: [],
          },
        });
      }
      case "update_item_fields": {
        const item = stub.items.get(String(body.item_key));
        if (item === undefined) return refusal(404, operation, "Item not found", body);
        Object.assign(item.fields, body.fields);
        return success(operation, {
          item_key: item.key,
          field_names: Object.keys(body.fields as object),
        });
      }
      case "attach_note": {
        const parent = String(body.parent_item_key);
        if (!stub.items.has(parent)) return refusal(404, operation, "Item not found", body);
        const noteKey = key();
        const note = String(body.note_text);
        children.set(parent, [
          ...stub.children(parent),
          {
            key: noteKey,
            data: { key: noteKey, parentItem: parent, itemType: "note", title: note, note },
          },
        ]);
        return success(
          operation,
          { parent_item_key: parent, note_length: note.length, title: note },
          { note_key: noteKey, note_id: next },
        );
      }
      case "trash_item": {
        const target = String(body.item_key);
        const item = stub.items.get(target);
        if (item !== undefined) {
          item.deleted = true;
          return success(operation, { item_key: target, item_type: "preprint" });
        }
        for (const [parent, held] of children) {
          if (held.some((child) => child.key === target)) {
            children.set(
              parent,
              held.filter((child) => child.key !== target),
            );
            return success(operation, { item_key: target, item_type: "attachment" });
          }
        }
        return refusal(404, operation, "Item not found", body);
      }
      case "resolve_url":
        return json(
          422,
          JSON.parse(
            readFileSync(join(import.meta.dir, "fixtures/zotero/resolve-unidentified.json"), "utf8"),
          ),
        );
      default:
        return refusal(400, operation, `Unsupported operation: ${operation}`, body);
    }
  };
  const attach = (body: Record<string, unknown>): Response => {
    const fileName = String(body.file_name);
    const attachmentKey = key();
    const parent = body.item_key === undefined ? null : String(body.item_key);
    const child: ZoteroChild = {
      key: attachmentKey,
      data: {
        key: attachmentKey,
        parentItem: parent ?? "",
        itemType: "attachment",
        title: String(body.title),
        contentType: contentType(fileName),
        filename: fileName,
      },
    };
    let collection: string | null = null;
    if (parent === null) {
      const selected = selectedCollection(body);
      if (selected instanceof Response) return selected;
      collection = selected;
      stub.standalone.push(child);
    } else {
      if (!stub.items.has(parent)) {
        return refusal(404, "attach_file_to_item", `Item not found: ${parent}`, body);
      }
      children.set(parent, [...stub.children(parent), child]);
    }
    return json(200, {
      success: true,
      operation: "attach_file_to_item",
      stage: "completed",
      version: ADDON_VERSION,
      attachment_key: attachmentKey,
      attachment_id: next,
      message: `Attached ${fileName}`,
      handler: "fulltext-attach",
      details: {
        parent_item_key: parent,
        collection_key: collection,
        file_path: null,
        source_mode: "bytes",
        title: String(body.title),
      },
    });
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(incoming) {
      const url = new URL(incoming.url);
      const request: ZoteroRequest = {
        method: incoming.method,
        path: url.pathname + url.search,
        body: incoming.method === "POST" ? await incoming.json() : null,
      };
      stub.requests.push(request);
      const refused = stub.refuse?.(request) ?? null;
      if (refused !== null) return refused;
      if (request.method === "GET" && url.pathname === "/version") {
        return new Response(VERSION, { headers: { "Content-Type": "application/json" } });
      }
      if (request.method === "POST" && url.pathname === "/write") {
        return write(request.body ?? {});
      }
      if (request.method === "POST" && url.pathname === "/attach") {
        return attach(request.body ?? {});
      }
      const read = url.pathname.match(/^\/api\/users\/0\/items\/([^/]+)\/children$/);
      if (request.method === "GET" && read !== null) {
        const itemType = url.searchParams.get("itemType");
        const held = stub
          .children(read[1])
          .filter((child) => itemType === null || child.data.itemType === itemType);
        return json(200, held, { "Total-Results": String(held.length) });
      }
      return new Response("No endpoint found\n", {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      });
    },
  });
  stub.url = server.url.origin;
  return stub;
}
