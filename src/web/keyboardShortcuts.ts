// The window's keyboard shortcuts, as editors bind them: Ctrl+F finds in the table, Ctrl+P goes to
// a PDF by fuzzy title, Ctrl+Shift+P runs a command. As browsers bind them: Ctrl+W closes the
// PDF tab shown, Ctrl+Tab and Ctrl+Shift+Tab show the next and the previous tab.
const KEYBOARD_MODIFIERS = ["ctrl", "shift", "alt", "meta"] as const;

type KeyboardModifier = (typeof KEYBOARD_MODIFIERS)[number];

export type KeyboardShortcut = { key: string; modifiers: KeyboardModifier[] };

export const KEYBOARD_SHORTCUTS = {
  focusSearch: { key: "f", modifiers: ["ctrl"] },
  openItemPalette: { key: "p", modifiers: ["ctrl"] },
  openCommandPalette: { key: "p", modifiers: ["ctrl", "shift"] },
  closeTab: { key: "w", modifiers: ["ctrl"] },
  nextTab: { key: "tab", modifiers: ["ctrl"] },
  previousTab: { key: "tab", modifiers: ["ctrl", "shift"] },
} satisfies Record<string, KeyboardShortcut>;

export type ShortcutAction = keyof typeof KEYBOARD_SHORTCUTS;
export const SHORTCUT_ACTIONS: { action: ShortcutAction; label: string }[] = [
  { action: "focusSearch", label: "Find in library" },
  { action: "openItemPalette", label: "Find PDF" },
  { action: "openCommandPalette", label: "Commands" },
  { action: "closeTab", label: "Close PDF tab" },
  { action: "nextTab", label: "Next tab" },
  { action: "previousTab", label: "Previous tab" },
];

const STORAGE_KEY = "pdf-bucket-keybindings";

export function keybindings(): Record<ShortcutAction, KeyboardShortcut> {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<
    string,
    KeyboardShortcut
  >;
  return Object.fromEntries(
    SHORTCUT_ACTIONS.map(({ action }) => [action, saved[action] ?? KEYBOARD_SHORTCUTS[action]]),
  ) as Record<ShortcutAction, KeyboardShortcut>;
}

export function saveKeybinding(action: ShortcutAction, shortcut: KeyboardShortcut): void {
  const bindings = keybindings();
  if (
    Object.entries(bindings).some(
      ([other, bound]) => other !== action && sameShortcut(bound, shortcut),
    )
  ) {
    throw new Error("This keybinding is already in use");
  }
  bindings[action] = shortcut;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
}

export function resetKeybindings(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function shortcutFromEvent(event: KeyboardEvent): KeyboardShortcut | null {
  const key = event.key.toLowerCase();
  const valid =
    !["control", "shift", "alt", "meta"].includes(key) &&
    (event.ctrlKey || event.metaKey || event.altKey);
  return valid
    ? { key, modifiers: KEYBOARD_MODIFIERS.filter((modifier) => modifierPressed(event, modifier)) }
    : null;
}

export function shortcutLabel(shortcut: KeyboardShortcut): string {
  const keyLabel =
    {
      tab: "Tab",
      arrowleft: "Left Arrow",
      arrowright: "Right Arrow",
      arrowup: "Up Arrow",
      arrowdown: "Down Arrow",
      " ": "Space",
    }[shortcut.key] ?? shortcut.key.toUpperCase();
  return [
    ...shortcut.modifiers.map((modifier) => modifier[0].toUpperCase() + modifier.slice(1)),
    keyLabel,
  ].join("+");
}

function sameShortcut(first: KeyboardShortcut, second: KeyboardShortcut): boolean {
  return (
    first.key === second.key &&
    KEYBOARD_MODIFIERS.every(
      (modifier) => first.modifiers.includes(modifier) === second.modifiers.includes(modifier),
    )
  );
}

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
