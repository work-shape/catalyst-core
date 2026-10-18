import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  WORKFLOW_ASSET_KIND,
  asClientInstanceId,
  type ToolExecutionContext
} from "@work-shape/catalyst-core";
import {
  createPlatformAssetBinding,
  createPlatformAssetTools
} from "@work-shape/catalyst-tool-execution";
import { childRulesRevisionWarnings, parseWorkflowManifest } from "@work-shape/catalyst-workflows";
import type { WorkflowFixture } from "./support/workflow-instance";
import { readyWorkflows } from "./support/workflow-runs";

// A child that declares `rulesRevision` says that a run under other rules is another run. A
// keyed parent step whose key does not hold what it passes there would be answered by a run
// that is done under the old rules, so a check warns of it. The warning reads the mapping, the
// key and the child's published inputs, never a script, and it refuses nothing.

const CODE = "child_key_without_rules_revision";
const ref = (step: string, path: string) => ({ ref: { step, path } });

/** The child; `null` declares no rules revision. */
const child = (revision: Record<string, unknown> | null = { type: "string" }) => ({
  id: "check-client",
  name: "Check one client",
  runAs: "workflow-runner",
  inputs: {
    type: "object",
    properties: {
      client: { type: "string" },
      ...(revision ? { rulesRevision: revision } : {})
    },
    required: ["client"]
  },
  outputs: { type: "object" },
  steps: [
    { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "parent" }] },
    { id: "result", name: "Result", type: "output", input: {} }
  ]
});

/** A parent that passes the revision it is started with, and the key as given, per client. */
const parent = (
  key: unknown[] | undefined,
  revision: unknown = ref("start", "input.revision")
) => ({
  id: "check-month",
  name: "Check the month",
  runAs: "workflow-runner",
  inputs: { type: "object" },
  outputs: { type: "object" },
  steps: [
    { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
    {
      id: "each_client",
      name: "For each client",
      type: "loop",
      items: { step: "start", path: "input.clients" },
      steps: [
        {
          id: "check",
          name: "Check the client",
          type: "workflow",
          workflow: "check-client",
          input: { client: ref("each_client", "id"), rulesRevision: revision },
          ...(key ? { key } : {})
        }
      ]
    },
    { id: "result", name: "Result", type: "output", input: {} }
  ]
});

describe("the rules revision of a child in its parent's run key", () => {
  const warned = async (parentValue: unknown, childValue: unknown) => {
    const read = parseWorkflowManifest(parentValue);
    const published = parseWorkflowManifest(childValue);
    if (!read.ok || !published.ok) throw new Error("Invalid fixture");
    const source = { read: async () => ({ revisionId: "r1", manifest: published.manifest }) };
    return (await childRulesRevisionWarnings(read.manifest, source)).map(({ code }) => code);
  };
  const month = { value: "2026-09" };
  const client = ref("each_client", "id");

  it("warns of a key without the revision, inside a loop too", async () => {
    expect(await warned(parent([month, client]), child())).toEqual([CODE]);
    // The same value from another source is not the source the step passes.
    expect(await warned(parent([month, ref("start", "input.other"), client]), child())).toEqual([
      CODE
    ]);
  });

  it("is silent where the key holds the source the step passes, or the child's fixed value", async () => {
    expect(await warned(parent([month, ref("start", "input.revision"), client]), child())).toEqual(
      []
    );
    const literal = { value: "rules-4" };
    expect(await warned(parent([month, literal, client], literal), child())).toEqual([]);
    expect(
      await warned(parent([month, literal, client]), child({ type: "string", const: "rules-4" }))
    ).toEqual([]);
  });

  it("preserves a non-blocking warning through the agent check tool and its output schema", async () => {
    const warnings = [{ code: CODE, message: "Include the rules revision in the child key." }];
    const tools = createPlatformAssetTools({
      ...createPlatformAssetBinding().calls,
      validate: async () => ({ issues: [], warnings })
    });
    const tool = tools.find((entry) => entry.name === "platform.assets.validate");
    if (!tool || !tool.outputSchema) throw new Error("Missing check tool schema");
    const clientInstanceId = asClientInstanceId("warning-tool");
    const context: ToolExecutionContext = {
      clientInstanceId,
      correlationId: "warning-tool",
      user: {
        id: "reader",
        externalUserId: "reader",
        displayLabel: "Reader",
        roles: ["user"],
        permissionRefs: [],
        clientInstanceId,
        authSource: "test"
      }
    };
    const answer = await tool.execute(tool.inputSchema.parse({ config: {} }), context);
    expect(answer).toMatchObject({
      status: "success",
      output: { valid: true, issues: [], warnings }
    });
    if (answer.status !== "success") throw new Error("Check failed");
    expect(tool.outputSchema.parse(answer.output)).toEqual({ valid: true, issues: [], warnings });
  });

  it("is silent for an unkeyed step and for a child without the convention", async () => {
    expect(await warned(parent(undefined), child())).toEqual([]);
    expect(await warned(parent([month, client]), child(null))).toEqual([]);
  });
});

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});

describe("a check of a Workflow asset", () => {
  it("answers the warning beside a valid definition, and a save still stores it", async () => {
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { definitions: "assets" }
    );
    const childAddress = { kind: WORKFLOW_ASSET_KIND, name: "check-client" };
    const written = await t.expectOk(t.admin.id, "assets.put", {
      params: childAddress,
      payload: { config: { name: "check-client", manifest: child() }, expectedRevision: null }
    });
    const { revision } = z.object({ revision: z.number() }).parse(written.json());
    await t.expectOk(t.root.id, "assets.publish", { params: childAddress, payload: { revision } });

    const checkSchema = z.object({
      valid: z.boolean(),
      issues: z.array(z.unknown()),
      warnings: z.array(z.object({ code: z.string(), message: z.string() })).optional()
    });
    const check = async (manifest: unknown) =>
      checkSchema.parse(
        (
          await t.expectOk(t.admin.id, "assets.validate", {
            params: { kind: WORKFLOW_ASSET_KIND },
            payload: { config: { name: "check-month", manifest } }
          })
        ).json()
      );
    const month = { value: "2026-09" };
    const without = await check(parent([month, ref("each_client", "id")]));
    expect(without).toMatchObject({ valid: true, issues: [] });
    expect(without.warnings?.map(({ code }) => code)).toEqual([CODE]);
    expect(without.warnings?.[0]?.message).toContain("'check'");

    const held = await check(
      parent([month, ref("start", "input.revision"), ref("each_client", "id")])
    );
    expect(held).toEqual({ valid: true, issues: [] });

    // A warning refuses nothing.
    const saved = await t.call(t.admin.id, "assets.put", {
      params: { kind: WORKFLOW_ASSET_KIND, name: "check-month" },
      payload: {
        config: { name: "check-month", manifest: parent([month, ref("each_client", "id")]) },
        expectedRevision: null
      }
    });
    expect(saved.statusCode, saved.body).toBe(200);
  });
});
