import * as Dialog from "@radix-ui/react-dialog";
import { Command as CmdK } from "cmdk";
import { FileText, Search, Terminal } from "lucide-react";
import { type KeyboardEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BucketItem } from "../../server/libraryContract";
import type { Command } from "../commands";
import { shortDate, sourceDomain } from "../format";
import { buildSearchDocuments, rankForPalette, type SearchDocument } from "../search";

const PALETTE_RESULT_LIMIT = 25;

export type PaletteMode = "items" | "commands";

type CommandPaletteProps = {
  initialMode: PaletteMode;
  items: BucketItem[];
  commands: Command[];
  onSelectItem: (id: string) => void;
  onClose: () => void;
};

const ROW_CLASSES =
  "flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 text-sm text-ink data-[selected=true]:bg-accent-soft";

export default function CommandPalette({
  initialMode,
  items,
  commands,
  onSelectItem,
  onClose,
}: CommandPaletteProps) {
  const [mode, setMode] = useState<PaletteMode>(initialMode);
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    input.current?.focus();
  }, []);

  const documents = useMemo(() => buildSearchDocuments(items), [items]);
  const ranked = useMemo(
    () => rankForPalette(documents, query).slice(0, PALETTE_RESULT_LIMIT),
    [documents, query],
  );

  const onValueChange = (value: string) => {
    if (mode === "items" && value.startsWith(">")) {
      setMode("commands");
      setQuery(value.slice(1));
      return;
    }
    setQuery(value);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Backspace" && mode === "commands" && query.length === 0) {
      setMode("items");
    }
  };

  const renderItem = ({ item }: SearchDocument) => (
    <CmdK.Item
      key={item.id}
      value={item.id}
      onSelect={() => {
        onSelectItem(item.id);
        onClose();
      }}
      className={ROW_CLASSES}
    >
      <FileText aria-hidden className="h-4 w-4 shrink-0 text-red-600" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{item.title}</span>
        <span className="truncate text-xs text-muted">
          {sourceDomain(item.url)} · {shortDate(item.dateAdded)}
        </span>
      </span>
    </CmdK.Item>
  );

  const renderCommand = (command: Command) => (
    <CmdK.Item
      key={command.id}
      value={`${command.category} ${command.name}`}
      onSelect={() => {
        command.action();
        onClose();
      }}
      className={ROW_CLASSES}
    >
      <Terminal aria-hidden className="h-4 w-4 shrink-0 text-muted" />
      <span className="flex-1 truncate">
        <span className="text-muted">{command.category}: </span>
        {command.name}
      </span>
    </CmdK.Item>
  );

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/20" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-x-0 top-[12%] z-50 mx-auto w-full max-w-xl px-4 outline-none"
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <CmdK
            label="Command palette"
            shouldFilter={mode === "commands"}
            className="overflow-hidden rounded-xl border border-line bg-white shadow-2xl"
          >
            <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
              {mode === "commands" ? (
                <Terminal aria-hidden className="h-5 w-5 text-accent" />
              ) : (
                <Search aria-hidden className="h-5 w-5 text-muted" />
              )}
              <CmdK.Input
                ref={input}
                value={query}
                onValueChange={onValueChange}
                onKeyDown={onKeyDown}
                placeholder={mode === "commands" ? "Command" : "Go to PDF"}
                className="w-full bg-transparent text-base outline-none placeholder:text-faint"
              />
            </div>
            <CmdK.List className="max-h-80 overflow-y-auto p-1.5">
              <CmdK.Empty className="py-8 text-center text-sm text-muted">No match</CmdK.Empty>
              {mode === "commands" ? commands.map(renderCommand) : ranked.map(renderItem)}
            </CmdK.List>
          </CmdK>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
