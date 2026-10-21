import { describe, expect, it } from "vitest";
import { APP_WORKFLOW_RUN_OUTPUT_MAX_BYTES, appWorkflowRunOutput } from "@work-shape/catalyst-core";

// DP-0b: a frame is handed a Workflow Run's whole output up to the size of an action result,
// and above it only that it was cut. The engine keeps a run's output within the same size
// (WORKFLOW_STEP_DATA_MAX_BYTES), so no run reaches the cap through a frame's call; the rule
// is read here, and app-workflow-actions.test.ts follows a long output to the frame.

describe("the output of a Workflow Run as a frame is answered it", () => {
  it("answers an output of 5,000 characters whole", () => {
    const output = { report: "x".repeat(5_000) };

    expect(appWorkflowRunOutput(output)).toEqual({ output });
  });

  it("answers an output of exactly the cap whole, and one byte more as cut", () => {
    // `{"t":"…"}` is 8 bytes around the text.
    const atCap = { t: "y".repeat(APP_WORKFLOW_RUN_OUTPUT_MAX_BYTES - 8) };
    const overCap = { t: "y".repeat(APP_WORKFLOW_RUN_OUTPUT_MAX_BYTES - 7) };

    expect(appWorkflowRunOutput(atCap)).toEqual({ output: atCap });
    expect(appWorkflowRunOutput(overCap)).toEqual({ outputTruncated: true });
  });

  it("counts bytes, not characters", () => {
    // "ä" is two bytes as UTF-8: half the cap in characters is the whole cap in bytes.
    const wide = { t: "ä".repeat(APP_WORKFLOW_RUN_OUTPUT_MAX_BYTES / 2) };

    expect(appWorkflowRunOutput(wide)).toEqual({ outputTruncated: true });
  });
});
