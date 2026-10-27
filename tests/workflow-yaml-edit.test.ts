import { describe, expect, it, vi } from "vitest";
import { asClientInstanceId, readYamlData } from "@work-shape/catalyst-core";
import { createWorkflowAssetKind } from "@work-shape/catalyst-client-assembly";
import { WORKFLOW_UNBOUNDED_CEILINGS } from "@work-shape/catalyst-workflows";
import { z } from "zod";
import * as yaml from "yaml";

vi.mock("yaml", { spy: true });

const untouched = () => Promise.reject(new Error("A document edit reads no asset or grant"));
const kind = createWorkflowAssetKind({
  clientInstanceId: asClientInstanceId("ci_test"),
  repository: true,
  limits: { ceilings: WORKFLOW_UNBOUNDED_CEILINGS, stepSlots: 4 },
  configAssets: { getConfigAsset: untouched, listPublishedConfigAssets: untouched },
  apiAccess: { findServicePrincipalByName: untouched, findServicePrincipalByOwner: untouched },
  access: { loadPersistedAccess: untouched, listGrantScopeAssets: untouched }
});

function editWorkflowManifest(original: string, manifest: unknown): string | undefined {
  const edit = kind.revisionFiles?.editManifest;
  if (!edit) throw new Error("No document edit hook");
  const bytes = edit({ name: "example", manifest }, new TextEncoder().encode(original));
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
}

const annotatedWorkflow = `# Maintained by the operations team.
name: Example # Keep this name note.
id: example
runAs: workflow-runner
inputs: { type: object }
outputs: { type: object }

# Steps stay in execution order.
steps:
  # The entry point.
  - id: start
    name: Start
    type: trigger
    triggers:
      - kind: manual # Started by a person.

  # Keep this step's explanation.
  - id: first
    type: output
    name: First # The displayed name.
    input: {}
    description: Remove this field.

  # Remove this step's explanation with its step.
  - id: obsolete
    type: output
    name: Obsolete
    input: {}

  # The final step's explanation.
  - id: result
    type: output
    name: Result
    input: {}
`;

function read(text: string): Record<string, unknown> {
  const read = readYamlData(text, "workflow.yaml", { refuseAliases: true });
  if (!read.ok) throw new Error("Invalid test YAML");
  return z.record(z.string(), z.unknown()).parse(read.value);
}

describe("Workflow manifest document edits", () => {
  it("keeps comments, blank lines and untouched key order across rename, add, remove and trigger edits", () => {
    const manifest = read(annotatedWorkflow);
    const steps = z.array(z.record(z.string(), z.unknown())).parse(manifest.steps);
    const trigger = steps[0];
    const first = steps[1];
    const last = steps[3];
    if (!trigger || !first || !last) throw new Error("Missing fixture steps");
    trigger.triggers = [{ kind: "schedule", cron: "0 9 * * *" }];
    first.name = "Renamed";
    delete first.description;
    manifest.steps = [
      trigger,
      first,
      { name: "Added", input: {}, type: "output", id: "added" },
      last
    ];
    manifest.description = "New description";
    manifest.kind = "process";
    const text = editWorkflowManifest(annotatedWorkflow, manifest);
    expect(text).toBeDefined();
    if (text === undefined) throw new Error("The edit fell back");
    expect(read(text)).toEqual(manifest);
    expect(text).toContain("# Maintained by the operations team.");
    expect(text).toContain("name: Example # Keep this name note.\nid: example");
    expect(text).toContain("\n\n# Steps stay in execution order.");
    expect(text).toContain("# The entry point.");
    expect(text).toContain("kind: schedule # Started by a person.");
    expect(text).toContain("# Keep this step's explanation.");
    expect(text).toContain("type: output\n    name: Renamed # The displayed name.");
    expect(text).not.toContain("obsolete");
    expect(text).not.toContain("Remove this step");
    expect(text).toContain("# The final step's explanation.");
    expect(text).toContain("- id: added\n    name: Added\n    type: output\n    input: {}");
    expect(text.indexOf("description: New description")).toBeLessThan(
      text.indexOf("kind: process")
    );
  });

  it("keeps moved steps with their annotations, including nested steps", () => {
    const source = `id: example
name: Example
steps:
  - id: block
    type: condition
    then:
      - id: first # First note.
        type: output
      - id: second # Second note.
        type: output
`;
    const manifest = read(source);
    const steps = z.array(z.record(z.string(), z.unknown())).parse(manifest.steps);
    manifest.steps = steps;
    const block = steps[0];
    if (!block) throw new Error("Missing fixture block");
    block.then = z.array(z.unknown()).parse(block.then).toReversed();
    const text = editWorkflowManifest(source, manifest);
    if (text === undefined) throw new Error("The edit fell back");
    expect(read(text)).toEqual(manifest);
    expect(text).toContain("- id: second # Second note.");
    expect(text).toContain("- id: first # First note.");
  });

  it("retains multiple blank lines and CRLF around untouched parts during a change", () => {
    const source = `\n${annotatedWorkflow}`.replaceAll("\n\n", "\n\n\n").replaceAll("\n", "\r\n");
    const manifest = read(source);
    manifest.name = "Changed";
    const text = editWorkflowManifest(source, manifest);
    if (text === undefined) throw new Error("The edit fell back");
    expect(read(text)).toEqual(manifest);
    expect(text).toContain("\r\n\r\n\r\n# Steps stay in execution order.");
    expect(text).toContain("\r\n\r\n\r\n  # The final step's explanation.");
  });

  it("leaves a semantically unchanged file byte-for-byte intact", () => {
    const source = annotatedWorkflow.replace("\n\n", "\n\n\n").replaceAll("\n", "\r\n");
    expect(editWorkflowManifest(source, read(source))).toBe(source);
  });

  it("falls back for invalid source and when serialization does not equal the sent manifest", () => {
    expect(
      editWorkflowManifest("steps: [", { id: "example", name: "Example", steps: [] })
    ).toBeUndefined();
    expect(
      editWorkflowManifest("name: !custom Example", { id: "example", name: "Changed" })
    ).toBeUndefined();
    const original = yaml.parseDocument("id: example\nname: Example\nsteps: []");
    const mismatched = yaml.parseDocument("id: example\nsteps: []\nname: Unexpected");
    const parse = vi
      .spyOn(yaml, "parseDocument")
      .mockReturnValueOnce(original)
      .mockReturnValueOnce(mismatched);
    try {
      expect(
        editWorkflowManifest("id: example\nname: Example\nsteps: []", {
          id: "example",
          steps: [],
          name: "Requested"
        })
      ).toBeUndefined();
      expect(parse).toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });
});
