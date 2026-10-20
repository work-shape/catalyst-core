import type { ToolExecutionContext } from "@work-shape/catalyst-core";

/** What `read_skill` asks of the port about a save of the skill it reads. */
export interface SkillSaveApprovalCalls {
  /**
   * Whether a save of the skill `name` by the person of `context` files a request, and who may
   * decide it: `saveApproval` of `get`, for a skill the agent reads with `read_skill`. Nothing
   * where that person may not save it or a save applies at once.
   */
  skillSaveApproval(
    context: ToolExecutionContext,
    name: string
  ): Promise<{ approverNames: string[] } | undefined>;
}
