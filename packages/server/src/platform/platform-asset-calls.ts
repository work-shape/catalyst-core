import type { ObjectStorage } from "@work-shape/catalyst-core";
import { appEditCalls } from "./asset-calls/app-edit";
import type { PlatformAssetCalls } from "@work-shape/catalyst-tool-execution";
import type { AssetWorkflowOptions } from "../types";
import { appSaveCalls } from "./asset-calls/app-save";
import { discoveryCalls } from "./asset-calls/discovery";
import { putCalls } from "./asset-calls/put";
import { createAssetCallScope } from "./asset-calls/scope";
import { skillCalls } from "./asset-calls/skill";
import { subjectCalls } from "./asset-calls/subject";

// What carries the agent's asset tools out: the workflow of the asset operations of the API,
// called for the person the agent acts for, on the subject of the conversation the call came
// from and on the drafts that conversation created (BUILD-ALL-1), and the reads that find what
// is on the platform. Opening an asset makes it the subject, and so do the first save of a
// conversation about none and saving what the conversation opened as an App; nothing else
// does. A draft created while the conversation has a subject stays beside it. Nothing of an
// asset is decided here: the right, the checks of a
// definition, the revision and the audit rows are the ones a call of `assets.get`,
// `assets.validate`, `assets.put`, `assets.list`, `workspaces.files.list` and
// `platform.context.get` has. Each family of calls is a file of its own under `asset-calls/`,
// over one scope; a new family is one more line below.

export function createPlatformAssetCalls(
  options: AssetWorkflowOptions,
  workspaceObjects?: ObjectStorage
): PlatformAssetCalls {
  const scope = createAssetCallScope(options);
  return {
    ...appSaveCalls(scope),
    ...appEditCalls(scope, workspaceObjects),
    ...discoveryCalls(scope),
    ...putCalls(scope),
    ...skillCalls(scope),
    ...subjectCalls(scope)
  } satisfies PlatformAssetCalls;
}
