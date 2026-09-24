// What the library does outside its own page: open a URL in the default browser, show a file
// in the file manager, choose a folder. The desktop window does these through Tauri's opener
// and dialog plugins; a browser tab opens URLs itself and has no file manager or folder chooser.
import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

export function openInBrowser(url: string): Promise<void> {
  if (isTauri()) {
    return openUrl(url);
  }
  window.open(url, "_blank", "noopener");
  return Promise.resolve();
}

// Null in a browser tab, where no file manager is reachable.
export function showInFolder(): ((path: string) => Promise<void>) | null {
  return isTauri() ? revealItemInDir : null;
}

// The system folder chooser: the chosen folder's path, or null when the choice is cancelled.
// Null in a browser tab, where the path is typed instead.
export function chooseFolder(): (() => Promise<string | null>) | null {
  return isTauri() ? () => open({ directory: true, multiple: false }) : null;
}
