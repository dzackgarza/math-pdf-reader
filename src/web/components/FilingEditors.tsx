// Inline editors for an item's filing: add a tag or topic by name, add the item to a collection.
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Plus } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import type { Collection } from "../../server/libraryContract";

const ADD_BUTTON_CLASSES =
  "inline-flex h-6 w-6 items-center justify-center rounded-full border border-line text-muted hover:border-accent hover:text-accent";

export function AddByName({
  label,
  suggestions,
  onAdd,
}: {
  label: string;
  suggestions: string[];
  onAdd: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);

  // The field appears because the user asked to add; it takes the keyboard at once.
  useEffect(() => {
    if (editing) {
      input.current?.focus();
    }
  }, [editing]);

  if (!editing) {
    return (
      <button
        type="button"
        aria-label={label}
        onClick={() => setEditing(true)}
        className={ADD_BUTTON_CLASSES}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    );
  }

  const finish = () => {
    setEditing(false);
    setValue("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      finish();
    }
    if (event.key === "Enter" && value.trim().length > 0) {
      onAdd(value.trim());
      finish();
    }
  };

  return (
    <>
      <input
        aria-label={label}
        ref={input}
        list={listId}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={finish}
        className="h-6 w-36 rounded-full border border-accent px-2.5 text-xs outline-none"
      />
      <datalist id={listId}>
        {suggestions.map((suggestion) => (
          <option key={suggestion} value={suggestion}>
            {suggestion}
          </option>
        ))}
      </datalist>
    </>
  );
}

export function AddToCollection({
  collections,
  onAdd,
}: {
  collections: Collection[];
  onAdd: (collectionId: string) => void;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Add to collection"
          disabled={collections.length === 0}
          className={`${ADD_BUTTON_CLASSES} disabled:opacity-40`}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          className="z-50 max-h-72 min-w-48 overflow-y-auto rounded-lg border border-line bg-white p-1 text-sm shadow-lg"
        >
          {collections.map((collection) => (
            <DropdownMenu.Item
              key={collection.id}
              onSelect={() => onAdd(collection.id)}
              className="cursor-pointer rounded px-2.5 py-1.5 outline-none data-highlighted:bg-accent-soft"
            >
              {collection.name}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
