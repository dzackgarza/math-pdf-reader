// The commands the palette runs.
import type { SendWay } from "./libraryActions";
import { QUICK_FILTERS, quickFilterName } from "./librarySelectors";

export type Command = {
  id: string;
  name: string;
  category: "Go to" | "Library" | "Columns";
  action: () => void;
};

export type AppCommandActions = {
  navigate: (path: string) => void;
  newCollection: () => void;
  saveSearch: () => void;
  openSelectedInReader: (() => void) | null;
  openSelectedInBrowser: (() => void) | null;
  showSelectedInFolder: (() => void) | null;
  sendSelectedToZotero: ((way: SendWay) => void) | null;
  reloadLibrary: () => void;
  verifyAllSources: () => void;
  rebuildAllLost: () => void;
  showAllColumns: () => void;
  resetColumns: () => void;
};

export function createAppCommands(actions: AppCommandActions): Command[] {
  const goTo = (id: string, name: string, path: string): Command => ({
    id,
    name,
    category: "Go to",
    action: () => actions.navigate(path),
  });
  // A command on the selected PDF, present only while one is selected (and, for Show in
  // Folder, only where a file manager is reachable).
  const onSelected = (id: string, name: string, action: (() => void) | null): Command[] =>
    action === null ? [] : [{ id, name, category: "Library", action }];
  const send = actions.sendSelectedToZotero;
  const sendSelected = (id: string, name: string, way: SendWay): Command[] =>
    onSelected(id, name, send === null ? null : () => send(way));
  return [
    goTo("go-library", "Library", "/"),
    ...QUICK_FILTERS.map((filter) =>
      goTo(`go-${filter.view.kind}`, `Library, ${quickFilterName(filter)}`, filter.path),
    ),
    goTo("go-collections", "Collections", "/organization/collections"),
    goTo("go-topics", "Topics", "/organization/topics"),
    goTo("go-tags", "Tags", "/organization/tags"),
    goTo("go-saved", "Saved Searches", "/organization/saved"),
    goTo("go-settings", "Settings", "/settings"),
    ...onSelected("open-reader", "Open Selected PDF", actions.openSelectedInReader),
    ...onSelected("open-browser", "Open Selected PDF in Browser", actions.openSelectedInBrowser),
    ...onSelected("show-folder", "Show Selected PDF in Folder", actions.showSelectedInFolder),
    ...sendSelected("send-zotero", "Send Selected PDF to Zotero", "item"),
    ...sendSelected("send-zotero-extract", "Send Selected PDF to Zotero and Extract", "extracted"),
    ...sendSelected("send-zotero-pdf-only", "Send Selected PDF Only to Zotero", "pdf_only"),
    {
      id: "new-collection",
      name: "New Collection",
      category: "Library",
      action: actions.newCollection,
    },
    {
      id: "save-search",
      name: "Save Search",
      category: "Library",
      action: actions.saveSearch,
    },
    {
      id: "reload",
      name: "Reload Library",
      category: "Library",
      action: actions.reloadLibrary,
    },
    {
      id: "verify-all",
      name: "Verify All Sources",
      category: "Library",
      action: actions.verifyAllSources,
    },
    {
      id: "rebuild-all",
      name: "Rebuild Lost PDFs",
      category: "Library",
      action: actions.rebuildAllLost,
    },
    {
      id: "columns-all",
      name: "Show All Columns",
      category: "Columns",
      action: actions.showAllColumns,
    },
    {
      id: "columns-reset",
      name: "Reset Columns",
      category: "Columns",
      action: actions.resetColumns,
    },
  ];
}
