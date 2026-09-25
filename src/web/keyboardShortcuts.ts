// The window's keyboard shortcuts, as editors bind them: Ctrl+F finds in the table, Ctrl+P goes to
// a PDF by fuzzy title, Ctrl+Shift+P runs a command. As browsers bind them: Ctrl+W closes the
// PDF tab shown, Ctrl+Tab and Ctrl+Shift+Tab show the next and the previous tab.
const KEYBOARD_MODIFIERS = ["ctrl", "shift", "alt", "meta"] as const;

type KeyboardModifier = (typeof KEYBOARD_MODIFIERS)[number];

type KeyboardShortcut = { key: string; modifiers: KeyboardModifier[] };

export const KEYBOARD_SHORTCUTS = {
  focusSearch: { key: "f", modifiers: ["ctrl"] },
  openItemPalette: { key: "p", modifiers: ["ctrl"] },
  openCommandPalette: { key: "p", modifiers: ["ctrl", "shift"] },
  closeTab: { key: "w", modifiers: ["ctrl"] },
  nextTab: { key: "tab", modifiers: ["ctrl"] },
  previousTab: { key: "tab", modifiers: ["ctrl", "shift"] },
} satisfies Record<string, KeyboardShortcut>;

type KeyboardEventLike = Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">;

function modifierPressed(event: KeyboardEventLike, modifier: KeyboardModifier): boolean {
  switch (modifier) {
    case "ctrl":
      return event.ctrlKey;
    case "shift":
      return event.shiftKey;
    case "alt":
      return event.altKey;
    case "meta":
      return event.metaKey;
  }
}

export function matchesShortcut(event: KeyboardEventLike, shortcut: KeyboardShortcut): boolean {
  return (
    event.key.toLowerCase() === shortcut.key &&
    KEYBOARD_MODIFIERS.every(
      (modifier) => modifierPressed(event, modifier) === shortcut.modifiers.includes(modifier),
    )
  );
}
