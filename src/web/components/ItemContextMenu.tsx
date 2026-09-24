// The row context menu: what can be done to one PDF, as a file manager or Zotero offers it.
import * as ContextMenu from "@radix-ui/react-context-menu";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import type { BucketItem, Collection } from "../../server/libraryContract";

export type ItemCommands = {
  open: () => void;
  openInBrowser: () => void;
  retrieveMetadata: () => void;
  fileIn: (collectionId: string) => void;
  fileInNewCollection: () => void;
  addTag: () => void;
  send: () => void;
  copy: (text: string) => void;
  // Null where no file manager is reachable (a browser tab).
  showInFolder: (() => void) | null;
  delete: () => void;
};

const ITEM =
  "flex cursor-default items-center gap-2 rounded px-2.5 py-1.5 outline-none data-highlighted:bg-accent-soft data-disabled:text-faint";
const PANEL = "z-50 min-w-52 rounded-lg border border-line bg-white p-1 text-sm shadow-lg";
const SEPARATOR = "my-1 h-px bg-line";

function Item({ onSelect, children }: { onSelect: () => void; children: ReactNode }) {
  return (
    <ContextMenu.Item onSelect={onSelect} className={ITEM}>
      {children}
    </ContextMenu.Item>
  );
}

function Submenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger className={ITEM}>
        {label}
        <ChevronRight aria-hidden className="ml-auto h-3.5 w-3.5 text-muted" />
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent className={`${PANEL} max-h-80 overflow-y-auto`}>
          {children}
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}

export default function ItemContextMenu({
  item,
  collections,
  commands,
}: {
  item: BucketItem;
  collections: Collection[];
  commands: ItemCommands;
}) {
  const unfiledIn = collections.filter((collection) => !item.collections.includes(collection.id));
  return (
    <ContextMenu.Content className={PANEL}>
      <Item onSelect={commands.open}>Open</Item>
      <Item onSelect={commands.openInBrowser}>Open in Browser</Item>
      <ContextMenu.Separator className={SEPARATOR} />
      <Submenu label="Add to Collection">
        {unfiledIn.map((collection) => (
          <Item key={collection.id} onSelect={() => commands.fileIn(collection.id)}>
            {collection.name}
          </Item>
        ))}
        {unfiledIn.length > 0 && <ContextMenu.Separator className={SEPARATOR} />}
        <Item onSelect={commands.fileInNewCollection}>New Collection…</Item>
      </Submenu>
      <Item onSelect={commands.addTag}>Add Tag…</Item>
      <ContextMenu.Separator className={SEPARATOR} />
      <Item onSelect={commands.retrieveMetadata}>Retrieve Metadata</Item>
      <Item onSelect={commands.send}>Send to Zotero</Item>
      <Submenu label="Copy Link">
        <Item onSelect={() => commands.copy(item.provenance.source_url)}>Source Page</Item>
        <Item onSelect={() => commands.copy(item.provenance.pdf_url)}>PDF</Item>
      </Submenu>
      {commands.showInFolder !== null && (
        <Item onSelect={commands.showInFolder}>Show in Folder</Item>
      )}
      <ContextMenu.Separator className={SEPARATOR} />
      <Item onSelect={commands.delete}>Delete…</Item>
    </ContextMenu.Content>
  );
}
