// The filing picker: a combobox (cmdk inside a Radix popover, cmdk's documented pairing) that
// files the item under an existing collection, topic or tag, or creates one from the typed name.
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { Plus } from "lucide-react";
import { useState } from "react";

export type FilingOption = { id: string; name: string };

export function FilingPicker({
  label,
  options,
  onPick,
  onCreate,
}: {
  // What is being added, e.g. "collection"; names the trigger ("Add to collection") and field.
  label: "collection" | "topic" | "tag";
  options: FilingOption[];
  onPick: (id: string) => void;
  onCreate: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const name = query.trim();
  const exact = options.some((option) => option.name.toLowerCase() === name.toLowerCase());
  const close = () => {
    setOpen(false);
    setQuery("");
  };
  const trigger = label === "collection" ? "Add to collection" : `Add ${label}`;
  const field = `${label.charAt(0).toUpperCase()}${label.slice(1)}`;

  return (
    <Popover.Root open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={trigger}
          title={trigger}
          className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-line text-muted hover:border-accent hover:text-accent"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-50 w-60 overflow-hidden rounded-lg border border-line bg-panel text-sm shadow-lg"
        >
          <Command label={trigger}>
            <Command.Input
              aria-label={field}
              value={query}
              onValueChange={setQuery}
              placeholder={field}
              className="w-full border-b border-line px-3 py-2 outline-none placeholder:text-faint"
            />
            <Command.List className="max-h-60 overflow-y-auto p-1">
              {options.map((option) => (
                <Command.Item
                  key={option.id}
                  value={option.name}
                  onSelect={() => {
                    onPick(option.id);
                    close();
                  }}
                  className="cursor-pointer rounded px-2.5 py-1.5 data-[selected=true]:bg-accent-soft"
                >
                  {option.name}
                </Command.Item>
              ))}
              {name.length > 0 && !exact && (
                <Command.Item
                  value={`create ${name}`}
                  forceMount
                  onSelect={() => {
                    onCreate(name);
                    close();
                  }}
                  className="flex cursor-pointer items-center gap-2 rounded px-2.5 py-1.5 data-[selected=true]:bg-accent-soft"
                >
                  <Plus aria-hidden className="h-3.5 w-3.5 text-muted" />
                  {name}
                </Command.Item>
              )}
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
