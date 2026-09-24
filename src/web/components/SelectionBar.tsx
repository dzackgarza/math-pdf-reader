// The actions on the rows chosen with their checkboxes: tag them, file them into a collection,
// or clear the choice.
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { FolderPlus, Tag, X } from "lucide-react";
import type { Collection } from "../../server/libraryContract";

type SelectionBarProps = {
  count: number;
  collections: Collection[];
  onTag: () => void;
  onFile: (collectionId: string) => void;
  onFileInNew: () => void;
  onClear: () => void;
};

const BUTTON =
  "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium hover:bg-panel/60";
const MENU_ITEM = "cursor-default rounded px-2.5 py-1.5 outline-none data-[highlighted]:bg-surface";

export default function SelectionBar({
  count,
  collections,
  onTag,
  onFile,
  onFileInNew,
  onClear,
}: SelectionBarProps) {
  return (
    <div className="flex items-center gap-1.5 border-b border-line bg-accent-soft px-3 py-1.5 text-accent">
      <span className="px-1 text-sm font-semibold tabular-nums">{count} selected</span>
      <button type="button" aria-label="Tag selected" onClick={onTag} className={BUTTON}>
        <Tag className="h-4 w-4" /> Add Tag…
      </button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger aria-label="File selected" className={BUTTON}>
          <FolderPlus className="h-4 w-4" /> Add to Collection
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            sideOffset={4}
            className="z-50 max-h-80 w-56 overflow-y-auto rounded-lg border border-line bg-panel p-1 text-sm text-ink shadow-lg"
          >
            {collections.map((collection) => (
              <DropdownMenu.Item
                key={collection.id}
                onSelect={() => onFile(collection.id)}
                className={MENU_ITEM}
              >
                {collection.name}
              </DropdownMenu.Item>
            ))}
            {collections.length > 0 && <DropdownMenu.Separator className="my-1 h-px bg-line" />}
            <DropdownMenu.Item onSelect={onFileInNew} className={MENU_ITEM}>
              New Collection…
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <button
        type="button"
        aria-label="Clear selection"
        title="Clear selection"
        onClick={onClear}
        className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-panel/60"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
