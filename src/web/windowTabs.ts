import { WINDOW_TABS_KEY, type WindowTabs, WindowTabsSchema } from "../contract/library";

export function keepTabs(tabs: WindowTabs): void {
  sessionStorage.setItem(WINDOW_TABS_KEY, JSON.stringify(WindowTabsSchema.parse(tabs)));
}

export function keptTabs(): WindowTabs | null {
  const kept = sessionStorage.getItem(WINDOW_TABS_KEY);
  return kept === null ? null : WindowTabsSchema.parse(JSON.parse(kept));
}

export function dropKeptTabs(): void {
  sessionStorage.removeItem(WINDOW_TABS_KEY);
}

export function reloaded(): boolean {
  const [navigation] = performance.getEntriesByType("navigation");
  return navigation instanceof PerformanceNavigationTiming && navigation.type === "reload";
}

export function tabsToRestore(): WindowTabs | null {
  const kept = keptTabs();
  dropKeptTabs();
  return kept !== null && (kept.fromReaderReload || reloaded()) ? kept : null;
}
