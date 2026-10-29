import type { ModelUsageRefusal, WorkflowRunError } from "@work-shape/catalyst-core";

/** What a step failure says beside its code and its sentence. */
export interface WorkflowStepFailureOptions {
  /** The right the run's principal does not hold. */
  action?: string;
  /**
   * The refusal is no failure of one item: the run's principal is disabled or missing or does
   * not hold the right, or the instance's policy does not allow the operation from a Workflow.
   * Every further item would be refused the same way, so no loop continues past it.
   */
  systemic?: boolean;
  /** The usage limit that refused a model call of the step. */
  usageLimit?: ModelUsageRefusal;
}

/**
 * A step that cannot end as `done` and that no further attempt would help: its input does
 * not resolve, its operation is refused, its output is too large. The engine ends the step
 * and its run as `failed` with the code and the sentence. Any other error is a crash of the
 * attempt, and the job executor runs the step again.
 */
export class WorkflowStepFailure extends Error {
  readonly code: string;
  readonly action: string | undefined;
  readonly systemic: boolean;
  readonly usageLimit: ModelUsageRefusal | undefined;

  constructor(code: string, message: string, options: WorkflowStepFailureOptions = {}) {
    super(message);
    this.name = "WorkflowStepFailure";
    this.code = code;
    this.action = options.action;
    this.systemic = options.systemic === true;
    this.usageLimit = options.usageLimit;
  }

  toRunError(): WorkflowRunError {
    return {
      code: this.code,
      message: this.message,
      ...(this.action === undefined ? {} : { action: this.action }),
      ...(this.usageLimit === undefined ? {} : { usageLimit: this.usageLimit })
    };
  }
}
