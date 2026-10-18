import { workflowRunActor } from "./run-identity";
import {
  isAppError,
  type Notices,
  type NoticeSendInput,
  type PlatformStores,
  type WorkflowRun,
  type WorkflowStepRunRef
} from "@work-shape/catalyst-core";

/** Settling under the run lock makes a recovered step create no second Inbox item. */
export async function settleNoticeStep(input: {
  tx: PlatformStores;
  ref: WorkflowStepRunRef;
  run: WorkflowRun;
  notice: NoticeSendInput;
  notices?: (stores: PlatformStores) => Notices;
  finishedAt: string;
}): Promise<{ code: string; message: string } | undefined> {
  const { tx, ref, run, notice, finishedAt } = input;
  const notices = input.notices;
  if (!notices)
    return { code: "notices_unavailable", message: "The instance has no notice sender" };
  if (!(await workflowRunActor(tx.apiAccess, run))) {
    return { code: "principal_inactive", message: "The Workflow principal is no longer active" };
  }
  try {
    await tx.transaction(async (nested) => {
      const result = await notices(nested).send(notice, { correlationId: run.correlationId });
      await nested.workflowRuns.endStepRun({
        ...ref,
        status: "done",
        finishedAt,
        output: { ...result }
      });
    });
    return undefined;
  } catch (error) {
    if (!isAppError(error)) throw error;
    return {
      code: "notice_refused",
      message: "The notice could not be addressed or its content is invalid"
    };
  }
}
