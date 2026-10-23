import { beforeEach, vi } from "vitest";
import {
  DeterministicModelProvider,
  type ModelCompletionRequest
} from "@work-shape/catalyst-model-provider";
import { registerTestInstanceHooks } from "./test-instance";
import { registerWorkflowBatchHooks } from "./workflow-batch";
import { registerFollowUpHooks } from "./follow-up-fixture";
import { registerPlatformAssetToolsHooks } from "./platform-asset-tools";
import { registerInfrastructureWorldHooks } from "./infrastructure-world";
import { registerConfigCliHooks } from "./config-cli";

// Setup files execute for every file; imported support modules execute only once per worker.
// Register the database owner first so stack-ordered cleanup releases dependent resources first.
registerTestInstanceHooks();
registerWorkflowBatchHooks();
registerFollowUpHooks();
registerPlatformAssetToolsHooks();
registerInfrastructureWorldHooks();
registerConfigCliHooks();

function streamWithoutPacing() {
  if (vi.isMockFunction(DeterministicModelProvider.prototype.stream)) return;
  vi.spyOn(DeterministicModelProvider.prototype, "stream").mockImplementation(async function* (
    this: DeterministicModelProvider,
    request: ModelCompletionRequest
  ) {
    const completion = await this.complete(request);
    if (completion.toolCalls.length === 0 && completion.text.length > 0) {
      for (const delta of completion.text.match(/\S+\s*/gu) ?? [completion.text])
        yield { type: "text_delta" as const, delta };
    }
    yield { type: "completed" as const, completion };
  });
}

// A file/test that needs real pacing can restore this spy. Reinstall after a prior test's
// restoreAllMocks, without replacing one of the existing per-file stream implementations.
streamWithoutPacing();
beforeEach(streamWithoutPacing);
