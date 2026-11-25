import type { AppBuild } from "../contract/library";

export function appBuildSentence(build: AppBuild): string {
  switch (build.state) {
    case "current":
      return "Current: built from the source as it is now";
    case "stale":
      return "Old build: the source changed after this build. Quit Math PDF Reader and open it again to rebuild.";
    case "failed":
      return `Rebuild failed (exit ${build.exitStatus}): this window runs the previous build. The rebuild's output is in ${build.log}.`;
    case "unprovisioned":
      return "Not provisioned: Math PDF Reader has no record of an installed build";
  }
}

export function appBuildWarning(build: AppBuild): string | null {
  switch (build.state) {
    case "stale":
      return "Old build";
    case "failed":
      return "Rebuild failed";
    case "current":
    case "unprovisioned":
      return null;
  }
}
