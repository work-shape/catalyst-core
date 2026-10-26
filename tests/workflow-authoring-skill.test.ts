import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { WORKFLOW_EXECUTED_STEP_TYPES, WORKFLOW_STEP_TYPES } from "@work-shape/catalyst-core";
import {
  WORKFLOW_AUTHORING_EXAMPLES,
  checkChildContracts,
  childRulesRevisionWarnings,
  parseWorkflowManifest,
  readWorkflowManifest,
  workflowAuthoringSkill,
  workflowStepFileIssues,
  workflowStepTypesNotRun,
  type WorkflowStepFile
} from "@work-shape/catalyst-workflows";
import { WORKFLOW_FIXTURES } from "./support/workflow-instance";

// The skill an agent reads before it changes a Workflow says what the engine of this release
// runs. Its step reference is made from the engine's own list of step types, so the two cannot
// say different things; these tests fail when they do, and when an example stops being a
// definition the engine accepts. What it says of the step files of a `code` step is held
// against the check a save runs: the paths, the bounds and the codes it names are the ones
// that check answers.

const headings = [...workflowAuthoringSkill.content.matchAll(/^### `type: ([a-z]+)`$/gmu)].map(
  (match) => match[1]
);

describe("the skill for writing a Workflow", () => {
  it("leaves the run account out of a new Workflow and resolves notification people without asking for ids", () => {
    const { content } = workflowAuthoringSkill;
    expect(content).toContain("Leave it out of a new Workflow");
    expect(content).toContain("creates the\n  Workflow's own account");
    expect(content).toContain("Keep a `runAs` a definition already\n  has");
    expect(content).toContain("use a name from workflowPrincipals, never an invented");
    expect(content).not.toContain("If exactly one is offered");
    expect(content).not.toContain("runAs: workflow-runner");
    expect(content).not.toContain("choose-from-platform-context");
    expect(content).toContain("platform.context caller.id");
    expect(content).toContain("never ask the person to type an id");
    expect(content).toContain("sends no Inbox item or mail");
  });
  it("offers publishing confirmation and a named schedule zone", () => {
    expect(workflowAuthoringSkill.content).toContain("use assets.publish if it is available");
    expect(workflowAuthoringSkill.content).toContain("instance.timeZone");
    expect(workflowAuthoringSkill.content).toContain("German time means Europe/Berlin");
  });
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
          ? [
              {
                id: "tell",
                name: "Tell",
                type,
                to: { users: ["usr_ada"] },
                channels: ["inbox"],
                title: { value: "Notice" },
                text: { value: "Ready" }
              }
            ]
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
    expect(parseWorkflowManifest(withStep("notify")).ok).toBe(true);
    expect(workflowStepTypesNotRun()).not.toContain("agent");
    expect(parseWorkflowManifest(withStep("agent")).ok).toBe(true);
  });

  it("shows examples the engine accepts as they are written", () => {
    expect(WORKFLOW_AUTHORING_EXAMPLES.length).toBeGreaterThanOrEqual(2);
    for (const example of WORKFLOW_AUTHORING_EXAMPLES) {
      const parsed = readWorkflowManifest(example.yaml);
      expect(parsed.ok ? [] : parsed.issues, example.title).toEqual([]);
      expect(workflowAuthoringSkill.content).toContain(example.yaml);
    }
  });

  it("shows the fixture Workflow without a run account, so its publish makes its own", async () => {
    const file = await readFile(`${WORKFLOW_FIXTURES}/top-customers/workflow.yaml`, "utf8");
    const stored = readWorkflowManifest(file);
    const shown = readWorkflowManifest(WORKFLOW_AUTHORING_EXAMPLES[0]?.yaml ?? "");
    const withoutAccount = (manifest: object) =>
      Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== "runAs"));
    expect(stored.ok && shown.ok ? shown.manifest : shown).toEqual(
      stored.ok ? withoutAccount(stored.manifest) : stored
    );
    for (const example of WORKFLOW_AUTHORING_EXAMPLES)
      expect(example.yaml, example.title).not.toMatch(/^runAs:/mu);
  });

  describe("on the step files of a code step", () => {
    const { content } = workflowAuthoringSkill;
    /** The steps of a definition with one code step per file, as the parser reads them. */
    const stepsOf = (files: readonly string[]) => {
      const parsed = parseWorkflowManifest({
        id: "example",
        name: "Example",
        runAs: "workflow-runner",
        inputs: { type: "object" },
        outputs: { type: "object" },
        steps: [
          { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
          ...files.map((file, position) => ({
            id: `code${position}`,
            name: "Run",
            type: "code",
            file,
            input: {},
            inputSchema: { type: "object" },
            outputSchema: { type: "object" }
          })),
          { id: "result", name: "Result", type: "output", input: {} }
        ]
      });
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
      return parsed.manifest;
    };
    const issuesOf = (steps: readonly string[], files: readonly WorkflowStepFile[]) =>
      workflowStepFileIssues(stepsOf(steps), files).map(({ path, code }) => ({ path, code }));

    it("describes the immutable tree, entry alias, operator bounds and absolute IO paths", () => {
      for (const text of [
        "entry: lib/run.py",
        "file: run.py",
        "read-only",
        "PYTHONPATH",
        "NODE_PATH",
        "WORKFLOW_INPUT_FILE",
        "WORKFLOW_OUTPUT_FILE",
        "workflows.source.*",
        "code_file_missing"
      ])
        expect(content).toContain(text);
      expect(content).not.toContain("code_file_unused");
      expect(
        issuesOf(
          ["a.py"],
          [
            { path: "steps/a.py", content: "" },
            { path: "sql/query.sql", content: "select 1" }
          ]
        )
      ).toEqual([]);
    });
  });

  describe("on what the manifest holds beside the steps", () => {
    const { content } = workflowAuthoringSkill;
    const manifest = (fields: Record<string, unknown>) =>
      parseWorkflowManifest({
        id: "example",
        name: "Example",
        runAs: "workflow-runner",
        inputs: { type: "object" },
        outputs: { type: "object" },
        steps: [
          { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
          { id: "result", name: "Result", type: "output", input: {} }
        ],
        ...fields
      });
    const codes = (parsed: ReturnType<typeof manifest>) =>
      parsed.ok ? [] : parsed.issues.map((issue) => issue.code);

    it("says of onFailure and labels what the parser says", () => {
      expect(codes(manifest({ onFailure: "notify" }))).toEqual([]);
      expect(codes(manifest({ onFailure: "workflow.cleanup" }))).toEqual(["not_supported_yet"]);
      const labels = { client: { value: "acme" } };
      const labelled = manifest({ labels });
      expect(labelled.ok ? labelled.manifest.labels : labelled.issues).toEqual(labels);
      const [, fields = ""] = content.split("## What a manifest is");
      expect(fields.split("## ")[0]).toContain("- `onFailure`: optional. `notify`, the default");
      const notRun = content.split("## What this engine does not run yet")[1] ?? "";
      expect(fields.split("## ")[0]).toContain("- `labels`: optional mapping");
      expect(notRun).toContain("- `onFailure: workflow.<id>` on the manifest;");
      expect(notRun).not.toContain("`labels`");
      // What it said before NOTIFY-b ran `notify`.
      expect(content).not.toContain("`labels` and `onFailure` on the manifest");
      const mappings = content.split("## Mappings and references")[1]?.split("## ")[0] ?? "";
      expect(mappings).not.toContain("onFailure");
    });
  });

  describe("on the rules revision of a child", () => {
    const { content } = workflowAuthoringSkill;
    const child = parseWorkflowManifest({
      id: "check-client",
      name: "Check one client",
      runAs: "workflow-runner",
      inputs: {
        type: "object",
        properties: { client: { type: "string" }, rulesRevision: { type: "string" } },
        required: ["client", "rulesRevision"],
        additionalProperties: false
      },
      outputs: { type: "object" },
      steps: [
        { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "parent" }] },
        { id: "result", name: "Result", type: "output", input: {} }
      ]
    });
    if (!child.ok) throw new Error(JSON.stringify(child.issues));
    const source = { read: async () => ({ revisionId: "r1", manifest: child.manifest }) };
    /** The parent's steps the skill shows, inside a whole definition. */
    const shown = () => {
      const scope = content.split("## Preparing data scope")[1]?.split("## ")[0] ?? "";
      const steps = /```yaml\n([\s\S]*?)\n {2}```/u.exec(scope)?.[1] ?? "";
      return readWorkflowManifest(
        [
          "id: check-month",
          "name: Check the month",
          "runAs: workflow-runner",
          "inputs: { type: object }",
          "outputs: { type: object }",
          "steps:",
          "  - { id: start, name: Start, type: trigger, triggers: [{ kind: manual }] }",
          steps,
          "  - { id: result, name: Result, type: output, input: {} }"
        ].join("\n")
      );
    };

    it("shows one authored value that the child's input and its key both reference", async () => {
      const parsed = shown();
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
      const literals = JSON.stringify(parsed.manifest).match(/rules-4/gu) ?? [];
      expect(literals).toHaveLength(1);
      await expect(checkChildContracts(parsed.manifest, source)).resolves.toBeUndefined();
      expect(await childRulesRevisionWarnings(parsed.manifest, source)).toEqual([]);
      // It promises no reference into another definition, and names the warning a check gives.
      expect(content).toContain("the parent cannot read the child's revision");
      expect(content).toContain("`child_key_without_rules_revision`");
      // What it showed before: a key the parser does not read, and the revision in three places.
      expect(content).not.toContain('key: ["2026-09"');
      expect(content).not.toContain("Nothing checks the key");
    });

    it("tells how a load that may find no rows names the group it owns", () => {
      expect(content).toContain(
        "`replace: { by: [client_id, month, rules_revision], values: { client_id, month, rules_revision } }`"
      );
      expect(content).toContain("An empty dataset then clears that group only");
    });
  });
});
