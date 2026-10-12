import type { WorkflowRunError } from "@vivd-catalyst/core";

/**
 * A step that cannot end as `done` and that no further attempt would help: its input does
 * not resolve, its operation is refused, its output is too large. The engine ends the step
 * and its run as `failed` with the code and the sentence. Any other error is a crash of the
 * attempt, and the job executor runs the step again.
 */
export class WorkflowStepFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkflowStepFailure";
    this.code = code;
  }

  toRunError(): WorkflowRunError {
    return { code: this.code, message: this.message };
  }
}
