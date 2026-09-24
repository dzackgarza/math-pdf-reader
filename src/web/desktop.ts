// What the library does outside its own page: open a URL in the default browser and show a file
// in the file manager. The desktop window does both through Tauri's opener plugin; a browser
// tab opens URLs itself and has no file manager.
import { isTauri } from "@tauri-apps/api/core";
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
