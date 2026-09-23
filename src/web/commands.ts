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
            name: "Open selected PDF in the reader",
            category: "Library",
            action: actions.openSelectedInReader,
          },
        ];
  return [
    goTo("go-library", "Library", "/"),
    goTo("go-inbox", "Inbox", "/inbox"),
    goTo("go-collections", "Collections", "/organization/collections"),
    goTo("go-topics", "Topics", "/organization/topics"),
    goTo("go-tags", "Tags", "/organization/tags"),
    goTo("go-saved", "Saved searches", "/organization/saved"),
    goTo("go-settings", "Settings", "/settings"),
    ...reader,
    {
      id: "new-collection",
      name: "New collection",
      category: "Library",
      action: actions.newCollection,
    },
    {
      id: "save-search",
      name: "Save the current search",
      category: "Library",
      action: actions.saveSearch,
    },
    {
      id: "reload",
      name: "Reload the library from the bucket",
      category: "Library",
      action: actions.reloadLibrary,
    },
    {
      id: "columns-all",
      name: "Show all columns",
      category: "Columns",
      action: actions.showAllColumns,
    },
    {
      id: "columns-reset",
      name: "Reset columns",
      category: "Columns",
      action: actions.resetColumns,
    },
  ];
}
