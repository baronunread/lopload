// Every scenario, in one list. Both runners import this and nothing else:
//   - tests/app.test.ts  (bun test, Node host)
//   - src/selftest/      (the real app, Tauri host)
import { browseScenarios } from "./browse";
import { folderAndTrashScenarios } from "./foldersAndTrash";
import { transferScenarios } from "./transfer";
import type { Scenario } from "./types";

export const allScenarios: Scenario[] = [
  ...browseScenarios,
  ...folderAndTrashScenarios,
  ...transferScenarios,
];

export type { Scenario, ScenarioCtx } from "./types";
