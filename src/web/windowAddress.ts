import { useSyncExternalStore } from "react";
import { LIBRARY_VIEW_KEY } from "../contract/library";
import { readerPath } from "./routes";

const HASH_PREFIX = /^#?\/?/;

let libraryHash = window.location.hash;
let readerShown = false;
const listeners = new Set<() => void>();

function keep(hash: string): void {
  libraryHash = hash;
  sessionStorage.setItem(LIBRARY_VIEW_KEY, hash);
  for (const listener of listeners) {
    listener();
  }
}

keep(libraryHash);
window.addEventListener("hashchange", () => {
  if (!readerShown) {
    keep(window.location.hash);
  }
});

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const libraryPath = () => `/${libraryHash.replace(HASH_PREFIX, "")}`;

function navigateLibrary(to: string, options?: { replace?: boolean }): void {
  const hash = `#/${to.replace(HASH_PREFIX, "")}`;
  if (!readerShown) {
    const url = `/${hash}`;
    if (options?.replace === true) {
      window.history.replaceState(null, "", url);
    } else {
      window.history.pushState(null, "", url);
    }
  }
  keep(hash);
}

export function useLibraryLocation(): [string, typeof navigateLibrary] {
  return [useSyncExternalStore(subscribe, libraryPath), navigateLibrary];
}

useLibraryLocation.hrefs = (href: string) => `#${href}`;

export function showReaderAddress(key: string, page: number | undefined): void {
  readerShown = true;
  const fragment = page === undefined ? "" : `#page=${page}`;
  window.history.replaceState(null, "", `${readerPath(key)}${fragment}`);
}

export function showLibraryAddress(): void {
  readerShown = false;
  window.history.replaceState(null, "", `/${libraryHash}`);
}
