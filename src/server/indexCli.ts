// `bun src/server/indexCli.ts export | import | rebuild [<export file>]` over the configured
// data root and the index export beside it. `rebuild` prints one outcome per exported item
// and exits 1 when any PDF could not be restored.
import { CONFIG_PATH, dataRoot, indexExportFile, loadAppConfig } from "./config";
import { exportIndex, importIndex, rebuildCache } from "./indexExport";

const [command, file] = Bun.argv.slice(2);
const root = dataRoot();
const exportFile = file ?? indexExportFile();

if (command === "export") {
  const index = await exportIndex(root, exportFile);
  process.stdout.write(`exported ${index.items.length} items to ${exportFile}\n`);
} else if (command === "import") {
  const organization = await importIndex(root, exportFile);
  process.stdout.write(
    `imported the filing of ${Object.keys(organization.items).length} items into ${root}\n`,
  );
} else if (command === "rebuild") {
  const outcomes = await rebuildCache(root, exportFile, loadAppConfig(CONFIG_PATH).rebuild);
  process.stdout.write(`${JSON.stringify(outcomes, null, 2)}\n`);
  const unrestored = outcomes.filter(
    (outcome) => outcome.status === "dead" || outcome.status === "changed",
  );
  process.exitCode = unrestored.length > 0 ? 1 : 0;
} else {
  throw new Error("usage: bun src/server/indexCli.ts export | import | rebuild [<export file>]");
}
