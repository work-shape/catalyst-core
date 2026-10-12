import type { WorkflowRunError } from "@vivd-catalyst/core";

/** What a step failure says beside its code and its sentence. */
export interface WorkflowStepFailureOptions {
  /** The right the run's principal does not hold. */
  action?: string;
  /**
   * The refusal is of the run's principal itself: it is disabled or missing, or it does not
   * hold the right. Every further step would be refused the same way, so no loop continues
   * past it.
   */
  ofPrincipal?: boolean;
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
  readonly ofPrincipal: boolean;

  constructor(code: string, message: string, options: WorkflowStepFailureOptions = {}) {
    super(message);
    this.name = "WorkflowStepFailure";
    this.code = code;
    this.action = options.action;
    this.ofPrincipal = options.ofPrincipal === true;
  }

  toRunError(): WorkflowRunError {
    return {
      code: this.code,
      message: this.message,
      ...(this.action === undefined ? {} : { action: this.action })
    };
  }
}
