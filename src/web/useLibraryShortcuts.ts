// The library's own keys: Ctrl+F finds in the table; Enter opens and Delete deletes the selected
// PDF. Off while a PDF's tab is shown, while typing, and while a dialog or menu is open. The
// listener is registered once; useEffectEvent hands it the current selection and actions.
import { type RefObject, useEffect, useEffectEvent } from "react";
import { KEYBOARD_SHORTCUTS, matchesShortcut } from "./keyboardShortcuts";

export type LibraryShortcuts = {
  enabled: boolean;
  searchField: RefObject<HTMLInputElement | null>;
  // Null while no PDF is selected.
  onOpenSelected: (() => void) | null;
  onDeleteSelected: (() => void) | null;
};

export function useLibraryShortcuts(shortcuts: LibraryShortcuts): void {
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (!shortcuts.enabled) {
      return;
    }
    if (matchesShortcut(event, KEYBOARD_SHORTCUTS.focusSearch)) {
      event.preventDefault();
      shortcuts.searchField.current?.focus();
      shortcuts.searchField.current?.select();
      return;
    }
    const target = event.target;
    const typing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable);
    if (
      typing ||
      document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]') !== null
    ) {
      return;
    }
    if (event.key === "Enter" && shortcuts.onOpenSelected !== null) {
      event.preventDefault();
      shortcuts.onOpenSelected();
    }
    if (event.key === "Delete" && shortcuts.onDeleteSelected !== null) {
      event.preventDefault();
      shortcuts.onDeleteSelected();
    }
  });
  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
