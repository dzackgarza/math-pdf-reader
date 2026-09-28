// The shipped extraction plugins, read once from `/api/plugins/extractions`, and a run of one
// on an item. A run answers each outcome with its status in EXTRACTION_OUTCOME_STATUS.
import { useEffect, useState } from "react";
import {
  EXTRACTION_OUTCOME_STATUS,
  type ExtractionOutcome,
  ExtractionOutcomeSchema,
  type ExtractionPlugin,
  ExtractionPluginsResponseSchema,
} from "../contract/extraction";
import { requestError } from "./useLibraryApi";

export type PluginsState =
  | { status: "loading" }
  | { status: "ready"; plugins: ExtractionPlugin[] }
  | { status: "failed"; message: string };

const OUTCOME_STATUSES = new Set<number>(Object.values(EXTRACTION_OUTCOME_STATUS));

async function fetchPlugins(): Promise<ExtractionPlugin[]> {
  const response = await fetch("/api/plugins/extractions");
  if (!response.ok) {
    throw await requestError(response);
  }
  return ExtractionPluginsResponseSchema.parse(await response.json()).plugins;
}

export function useExtractionPlugins(): PluginsState {
  const [state, setState] = useState<PluginsState>({ status: "loading" });
  useEffect(() => {
    fetchPlugins().then(
      (plugins) => setState({ status: "ready", plugins }),
      (error: Error) => setState({ status: "failed", message: error.message }),
    );
  }, []);
  return state;
}

export async function runExtraction(key: string, pluginId: string): Promise<ExtractionOutcome> {
  const path = `/api/items/${encodeURIComponent(key)}/extractions/${encodeURIComponent(pluginId)}`;
  const response = await fetch(path, { method: "POST" });
  if (!OUTCOME_STATUSES.has(response.status)) {
    throw await requestError(response);
  }
  const outcome = ExtractionOutcomeSchema.parse(await response.json());
  const expected = EXTRACTION_OUTCOME_STATUS[outcome.status];
  if (response.status !== expected) {
    throw new Error(
      `the server answered a ${outcome.status} run with ${response.status}, not ${expected}`,
    );
  }
  return outcome;
}
