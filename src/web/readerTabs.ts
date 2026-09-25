// What the window's tab row (tabs.tsx) offers the library: opening a PDF's reader in a tab, and
// whether the Library tab is the one shown.
import { createContext, useContext } from "react";

export type ReaderTabsApi = {
  openReader: (key: string, title: string) => void;
  // False while a PDF's tab is shown: the library's shortcuts then stay off.
  libraryShown: boolean;
};

export const ReaderTabsContext = createContext<ReaderTabsApi | null>(null);

export function useReaderTabs(): ReaderTabsApi {
  const api = useContext(ReaderTabsContext);
  if (api === null) {
    throw new Error("useReaderTabs is called outside ReaderTabs");
  }
  return api;
}
