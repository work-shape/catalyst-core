import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { WORKFLOW_STEP_TYPES } from "@work-shape/catalyst-core";
import {
  WORKFLOW_AUTHORING_EXAMPLES,
  WORKFLOW_CODE_FILE_MAX_BYTES,
  WORKFLOW_CODE_LANGUAGES,
  WORKFLOW_EXECUTED_STEP_TYPES,
  WORKFLOW_STEP_FILES_MAX_BYTES,
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
    for (const type of ["agent"]) {
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

    it("says that a config holds its files, whatever the instance", () => {
      expect(content).toContain("The config is `{ name, manifest, files }`");
      expect(content).toContain("each\n   `{ path, content }`");
      // What it said while no instance stored a file.
      expect(content).not.toMatch(/keeps? (no )?step files/u);
      expect(content).not.toContain("do not add a `code` step");
    });

    it("names a file by the path a save accepts for the step's `file`, a folder below among it", () => {
      for (const [file, path] of [
        ["classify.py", "steps/classify.py"],
        ["checks/total.py", "steps/checks/total.py"]
      ] as const) {
        expect(content).toContain(`\`${file}\``);
        expect(content).toContain(path);
        expect(issuesOf([file], [{ path, content: "" }])).toEqual([]);
        // The step's own spelling of the path is no path of a file.
        expect(issuesOf([file], [{ path: file, content: "" }])).not.toEqual([]);
      }
      // Two steps may name one file, as it says.
      expect(content).toContain("Two steps may name the same file");
      expect(
        issuesOf(["classify.py", "classify.py"], [{ path: "steps/classify.py", content: "" }])
      ).toEqual([]);
    });

    it("names every ending the runner takes and the two bounds a save holds the files to", () => {
      for (const ending of Object.keys(WORKFLOW_CODE_LANGUAGES)) {
        expect(content).toContain(`\`.${ending}\``);
      }
      expect(content).toContain(`One script is at most ${WORKFLOW_CODE_FILE_MAX_BYTES} bytes`);
      expect(content).toContain(`together at most ${WORKFLOW_STEP_FILES_MAX_BYTES} bytes`);
      const fits = "#".repeat(WORKFLOW_CODE_FILE_MAX_BYTES);
      expect(issuesOf(["a.py"], [{ path: "steps/a.py", content: fits }])).toEqual([]);
    });

    it("names each issue of the files by the code and the path the check answers it with", () => {
      const good = { path: "steps/a.py", content: "" };
      const full = "#".repeat(WORKFLOW_CODE_FILE_MAX_BYTES);
      const names = Array.from(
        { length: Math.floor(WORKFLOW_STEP_FILES_MAX_BYTES / WORKFLOW_CODE_FILE_MAX_BYTES) + 1 },
        (_, position) => `part${position}.py`
      );
      const answered = [
        ...issuesOf(["a.py"], []),
        ...issuesOf(["a.py"], [good, { path: "a.py", content: "" }]),
        ...issuesOf(["a.py"], [good, { path: "steps/notes.md", content: "" }]),
        ...issuesOf(["a.py"], [good, good]),
        ...issuesOf(["a.py"], [{ ...good, content: "a\u0000b" }]),
        ...issuesOf(["a.py"], [good, { path: "steps/b.py", content: "" }]),
        ...issuesOf(["a.py"], [{ ...good, content: `${full}#` }]),
        ...issuesOf(
          names,
          names.map((name) => ({ path: `steps/${name}`, content: full }))
        )
      ];
      /** The path of an issue as the skill writes it: with the id and the position left open. */
      const told = ({ path, code }: { path: string; code: string }) =>
        `\`${code}\` at \`${path
          .replace(/^steps\.[^.]+\./u, "steps.<step id>.")
          .replace(/\[\d+\]/u, "[<position>]")}\``;
      const section = content.split("## The step files of a code step")[1] ?? "";
      const codes = new Set(answered.map((issue) => issue.code));
      expect([...codes].sort()).toEqual([
        "code_file_invalid",
        "code_file_missing",
        "code_file_too_large",
        "code_file_unused",
        "code_files_too_large"
      ]);
      for (const issue of answered) {
        // The content of a file is told in the entry of its code, after the path of the file.
        if (issue.path.endsWith(".content")) {
          expect(section).toContain("At `files[<position>].content`");
          continue;
        }
        expect(section, told(issue)).toContain(told(issue));
      }
      // And it names no code of a file that the check never answers.
      const named = [...section.matchAll(/^- `(code_[a-z_]+)` at /gmu)].map((match) => match[1]);
      expect(named.sort()).toEqual([...codes].sort());
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
      expect(codes(manifest({ labels: { client: { value: "acme" } } }))).toEqual([
        "not_supported_yet"
      ]);
      const [, fields = ""] = content.split("## What a manifest is");
      expect(fields.split("## ")[0]).toContain("- `onFailure`: optional. `notify`, the default");
      const notRun = content.split("## What this engine does not run yet")[1] ?? "";
      expect(notRun).toContain(
        "- `labels` on the manifest, and `onFailure: workflow.<id>` (EW-13);"
      );
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
