// Declared config surface: one JSON file, strict schema, no runtime defaults.
import { join } from "node:path";
import { xdgCache, xdgData } from "xdg-basedir";
import { type AppConfig, CONFIG_PATH, loadAppConfig, REPO_ROOT } from "../contract/config";

export { type AppConfig, CONFIG_PATH, loadAppConfig, REPO_ROOT };
export const WEB_DIST_DIR = join(REPO_ROOT, "dist/web");

// The Python store package owns provenance embedding and the folder layout.
export const STORE_COMMAND = ["uv", "run", "--project", REPO_ROOT, "--locked", "pdfbucket"];

// The prebuilt PDF.js viewer, unpacked from the pinned release by `just fetch-pdfjs`.
export function pdfjsDir(config: AppConfig): string {
  return join(REPO_ROOT, "vendor", `pdfjs-${config.pdfjs.version}`);
}

// Permanent data (stored PDFs, the library index) lives in the XDG data directory:
// $XDG_DATA_HOME/pdf-bucket, which is ~/.local/share/pdf-bucket when XDG_DATA_HOME is unset.
function xdgDataHome(): string {
  if (xdgData === undefined) {
    throw new Error("no XDG data directory: neither XDG_DATA_HOME nor HOME is set");
  }
  return xdgData;
}

export function dataRoot(): string {
  return join(xdgDataHome(), "pdf-bucket");
}

// The index export is permanent user data too, kept beside the data root rather than in it,
// so that wiping or losing the store leaves the export that rebuilds it.
export function indexExportFile(): string {
  return join(xdgDataHome(), "pdf-bucket-export", "index.json");
}

// Derived files the app can always make again (first-page thumbnails) live in the XDG cache
// directory: $XDG_CACHE_HOME/pdf-bucket, which is ~/.cache/pdf-bucket when it is unset.
export function cacheRoot(): string {
  if (xdgCache === undefined) {
    throw new Error("no XDG cache directory: neither XDG_CACHE_HOME nor HOME is set");
  }
  return join(xdgCache, "pdf-bucket");
}
