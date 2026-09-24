// The commands the palette runs.
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
  sendSelectedToZotero: (() => void) | null;
  reloadLibrary: () => void;
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
  const reader: Command[] =
    actions.openSelectedInReader === null
      ? []
      : [
          {
            id: "open-reader",
            name: "Open Selected PDF",
            category: "Library",
            action: actions.openSelectedInReader,
          },
        ];
  const send: Command[] =
    actions.sendSelectedToZotero === null
      ? []
      : [
          {
            id: "send-zotero",
            name: "Send Selected PDF to Zotero",
            category: "Library",
            action: actions.sendSelectedToZotero,
          },
        ];
  return [
    goTo("go-library", "Library", "/"),
    goTo("go-unfiled", "Unfiled", "/unfiled"),
    goTo("go-collections", "Collections", "/organization/collections"),
    goTo("go-topics", "Topics", "/organization/topics"),
    goTo("go-tags", "Tags", "/organization/tags"),
    goTo("go-saved", "Saved Searches", "/organization/saved"),
    goTo("go-settings", "Settings", "/settings"),
    ...reader,
    ...send,
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
