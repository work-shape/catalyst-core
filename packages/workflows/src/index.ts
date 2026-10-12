import { defineModule } from "@vivd-catalyst/core";

/**
 * Workflows: the asset kind `workflow`, its runs and the engine that executes their steps on
 * the job executor. The module is registered and contributes nothing yet, so an instance that
 * turns it on runs as it does with it off.
 */
export const workflowsModule = defineModule({ name: "workflows" });
