import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from "react";
import type { BucketItem } from "../../server/libraryContract";
import type { Command } from "../commands";
import { KEYBOARD_SHORTCUTS, matchesShortcut } from "../keyboardShortcuts";
import CommandPalette, { type PaletteMode } from "./CommandPalette";

export type CommandPaletteHostHandle = { open: (mode: PaletteMode) => void };

type CommandPaletteHostProps = {
  commands: Command[];
  items: BucketItem[];
  onSelectItem: (id: string) => void;
};

// Owns whether the palette is open and in which mode, and the global shortcuts that open it.
const CommandPaletteHost = forwardRef<CommandPaletteHostHandle, CommandPaletteHostProps>(
  function CommandPaletteHost({ commands, items, onSelectItem }, ref) {
    const [openMode, setOpenMode] = useState<PaletteMode | null>(null);
    const close = useCallback(() => setOpenMode(null), []);

    useImperativeHandle(ref, () => ({ open: setOpenMode }), []);

    useEffect(() => {
      const onKeyDown = (event: KeyboardEvent) => {
        if (matchesShortcut(event, KEYBOARD_SHORTCUTS.openCommandPalette)) {
          event.preventDefault();
          setOpenMode("commands");
        }
        if (matchesShortcut(event, KEYBOARD_SHORTCUTS.openItemPalette)) {
          event.preventDefault();
          setOpenMode((mode) => (mode === null ? "items" : null));
        }
      };
      window.addEventListener("keydown", onKeyDown, { capture: true });
      return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
    }, []);

    if (openMode === null) {
      return null;
    }
    return (
      <CommandPalette
        key={openMode}
        initialMode={openMode}
        items={items}
        commands={commands}
        onSelectItem={onSelectItem}
        onClose={close}
      />
    );
  },
);

export default CommandPaletteHost;
