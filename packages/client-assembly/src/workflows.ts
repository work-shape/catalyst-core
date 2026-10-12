import { workflowsModule } from "@vivd-catalyst/workflows";
import type { ModuleSeam } from "./module-assembly";

export { workflowsModule };

/** What an instance with the module `workflows` on has for its Workflows. Nothing yet. */
export const assembleWorkflows: ModuleSeam = ({ modules }) =>
  modules.isEnabled(workflowsModule.name) ? {} : undefined;
