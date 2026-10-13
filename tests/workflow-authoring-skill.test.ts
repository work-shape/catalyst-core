import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { WORKFLOW_STEP_TYPES } from "@vivd-catalyst/core";
import {
  WORKFLOW_AUTHORING_EXAMPLES,
  WORKFLOW_EXECUTED_STEP_TYPES,
  parseWorkflowManifest,
  readWorkflowManifest,
  workflowAuthoringSkill,
  workflowStepTypesNotRun
} from "@vivd-catalyst/workflows";
import { WORKFLOW_FIXTURES } from "./support/workflow-instance";

// The skill an agent reads before it changes a Workflow says what the engine of this release
// runs. Its step reference is made from the engine's own list of step types, so the two cannot
// say different things; these tests fail when they do, and when an example stops being a
// definition the engine accepts.

const headings = [...workflowAuthoringSkill.content.matchAll(/^### `type: ([a-z]+)`$/gmu)].map(
  (match) => match[1]
);

describe("the skill for writing a Workflow", () => {
  it("has one section per step type the engine runs, and no other", () => {
    expect(headings).toEqual([...WORKFLOW_EXECUTED_STEP_TYPES]);
  });

  it("names every step type the file form holds and the engine does not run, as not run", () => {
    const notRun = workflowStepTypesNotRun();
    expect([...notRun, ...WORKFLOW_EXECUTED_STEP_TYPES].sort()).toEqual(
      [...WORKFLOW_STEP_TYPES].sort()
    );
    const section = workflowAuthoringSkill.content.split("## What this engine does not run yet")[1];
    for (const type of notRun) {
      expect(section, type).toContain(`\`${type}\``);
      expect(headings).not.toContain(type);
    }
  });

  it("says of each step type what the parser says: a step of it is accepted, one of another refused", () => {
    const withStep = (type: string) => ({
      id: "example",
      name: "Example",
      runAs: "workflow-runner",
      inputs: { type: "object" },
      outputs: { type: "object" },
      steps: [
        { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
        ...(type === "notify"
          ? [{ id: "tell", name: "Tell", type, channel: "inbox", input: {} }]
          : type === "agent"
            ? [
                {
                  id: "ask",
                  name: "Ask",
                  type,
                  instructions: "ask.md",
                  input: {},
                  inputSchema: { type: "object" },
                  outputSchema: { type: "object" }
                }
              ]
            : []),
        { id: "result", name: "Result", type: "output", input: {} }
      ]
    });
    expect(parseWorkflowManifest(withStep("none")).ok).toBe(true);
    for (const type of ["notify", "agent"]) {
      expect(workflowStepTypesNotRun()).toContain(type);
      const parsed = parseWorkflowManifest(withStep(type));
      expect(parsed.ok ? [] : parsed.issues.map((issue) => issue.code)).toEqual([
        "not_supported_yet"
      ]);
    }
  });

  it("shows examples the engine accepts as they are written", () => {
    expect(WORKFLOW_AUTHORING_EXAMPLES.length).toBeGreaterThanOrEqual(2);
    for (const example of WORKFLOW_AUTHORING_EXAMPLES) {
      const parsed = readWorkflowManifest(example.yaml);
      expect(parsed.ok ? [] : parsed.issues, example.title).toEqual([]);
      expect(workflowAuthoringSkill.content).toContain(example.yaml);
    }
  });

  it("shows the Workflow of the fixtures as it is stored there", async () => {
    const file = await readFile(`${WORKFLOW_FIXTURES}/top-customers/workflow.yaml`, "utf8");
    const stored = readWorkflowManifest(file);
    const shown = readWorkflowManifest(WORKFLOW_AUTHORING_EXAMPLES[0]?.yaml ?? "");
    expect(stored.ok && shown.ok ? shown.manifest : shown).toEqual(
      stored.ok ? stored.manifest : stored
    );
  });
});
