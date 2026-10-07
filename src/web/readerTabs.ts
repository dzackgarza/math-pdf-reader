// What the window's tab row (tabs.tsx) offers the library: opening a PDF's reader in a tab,
// whether the Library tab is the one shown, and a place for the library's item menu, which a
// PDF's tab shows below its own entries.
import { createContext, type ReactNode, useContext } from "react";

// The context menu of KEY's item with TAB_ENTRIES first; null when the library holds no KEY.
export type ItemMenu = (key: string, tabEntries: ReactNode) => ReactNode | null;

export type ReaderTabsApi = {
  openReader: (key: string, title: string) => void;
  // Settles KEY's reader (its pending saves) and removes its tab; resolves at once when no tab
  // is open for KEY; rejects, keeping the tab, when a save failed.
  closeReader: (key: string) => Promise<void>;
  // False while a PDF's tab is shown: the library's shortcuts then stay off.
  libraryShown: boolean;
  // The library gives its item menu while it is mounted, and null when it unmounts.
  setItemMenu: (menu: ItemMenu | null) => void;
};

export const ReaderTabsContext = createContext<ReaderTabsApi | null>(null);

export function useReaderTabs(): ReaderTabsApi {
  const api = useContext(ReaderTabsContext);
  if (api === null) {
    throw new Error("useReaderTabs is called outside ReaderTabs");
  }
  return api;
}
