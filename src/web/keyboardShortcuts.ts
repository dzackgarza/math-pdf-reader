// Keyboard shortcuts for the command palette: Ctrl+K searches items, Ctrl+Shift+P runs commands.
const KEYBOARD_MODIFIERS = ["ctrl", "shift", "alt", "meta"] as const;

type KeyboardModifier = (typeof KEYBOARD_MODIFIERS)[number];

type KeyboardShortcut = { key: string; modifiers: KeyboardModifier[] };

export const KEYBOARD_SHORTCUTS = {
  openItemPalette: { key: "k", modifiers: ["ctrl"] },
  openCommandPalette: { key: "p", modifiers: ["ctrl", "shift"] },
} satisfies Record<string, KeyboardShortcut>;

type KeyboardEventLike = Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">;

const MODIFIER_LABELS: Record<KeyboardModifier, string> = {
  ctrl: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  meta: "Meta",
};

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

export function formatShortcut(shortcut: KeyboardShortcut): string {
  const modifiers = KEYBOARD_MODIFIERS.filter((modifier) => shortcut.modifiers.includes(modifier));
  return [
    ...modifiers.map((modifier) => MODIFIER_LABELS[modifier]),
    shortcut.key.toUpperCase(),
  ].join("+");
}
