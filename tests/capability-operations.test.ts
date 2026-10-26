import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCapability } from "@work-shape/catalyst-capability-sdk";
import { parseClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import { callableOperationsPageSchema, type OperationDefinition } from "@work-shape/catalyst-core";
import { createTestConfig } from "./support/fixtures";
import { output, save, trigger } from "./support/mail-workflows";
import { runSchema, workflowFixture } from "./support/workflow-instance";
import { stepRunsOf } from "./support/workflow-runs";
import { createTestInstance } from "./support/test-instance";

// ADR-0033: an operation a capability brings for Workflows is offered to a step by
// `platform.assets.operations` and `operations.list_callable`, as `mail.send` is; one that
// does not say so is not.

function operation(name: string, workflowStep: boolean): OperationDefinition {
  return {
    name,
    description: "A stand-in operation of a capability",
    effect: "changing",
    scope: null,
    auth: "principal",
    action: null,
    authorize: (_input, context) =>
      context.origin.kind === "workflow" ? { allowed: true } : { allowed: false, reason: "denied" },
    inputSchema: z.object({ text: z.string() }),
    outputSchema: z.object({}),
    resource: () => ({ kind: "stand_in", id: "new" }),
    timeoutMs: 1_000,
    ...(workflowStep ? { workflowStep: true as const } : {}),
    execute: () => Promise.resolve({})
  };
}

describe("a capability's operations", () => {
  it("are offered to a Workflow step where they say so", async () => {
    const capability = defineCapability({
      name: "stand-in",
      create: () => ({
        operations: [operation("stand_in.ask", true), operation("stand_in.hidden", false)]
      })
    });
    const config = parseClientInstanceConfig({
      ...createTestConfig({
        developmentAuth: {
          enabled: true,
          user: {
            id: "user-1",
            externalUserId: "user-1",
            displayLabel: "User",
            roles: ["user", "admin", "superadmin"]
          }
        }
      }),
      modules: { workflows: { enabled: true } }
    });
    const instance = await createTestInstance({
      config,
      env: {},
      tools: [],
      capabilities: [capability]
    });
    try {
      const response = await instance.call("operations.list_callable", {
        query: { prefix: "stand_in." }
      });
      expect(response.statusCode).toBe(200);
      const page = callableOperationsPageSchema.parse(response.json());
      expect(page.operations.map(({ name }) => name)).toEqual(["stand_in.ask"]);
    } finally {
      await instance.close();
    }
  });
});

describe("capabilities", () => {
  it("may not share a name", async () => {
    const capability = defineCapability({ name: "stand-in", create: () => ({}) });
    await expect(
      createTestInstance({
        config: parseClientInstanceConfig(createTestConfig()),
        env: {},
        tools: [],
        capabilities: [capability, capability]
      })
    ).rejects.toThrow("Two capabilities are named 'stand-in'");
  });
});

describe("an async operation that waits for weeks", () => {
  it("keeps its step waiting past the longest timer Node keeps", async () => {
    // 31 days is above 2^31 - 1 ms: a timer of that length would fire at once.
    const waiting: OperationDefinition = {
      ...operation("stand_in.wait", true),
      timeoutMs: 31 * 24 * 60 * 60 * 1_000,
      completion: { mode: "async", stillRunning: "Still waiting", example: {} },
      // Like a real one, it writes and sends before it answers, so a timer cut short wins.
      execute: () => new Promise((resolve) => setTimeout(() => resolve({}), 50))
    };
    const t = await workflowFixture({ definitions: "assets", operations: [waiting] });
    try {
      const manifest = {
        id: "waits",
        name: "Waits",
        runAs: "workflow-runner",
        inputs: { type: "object" },
        outputs: { type: "object" },
        steps: [
          trigger,
          {
            id: "wait",
            name: "Wait",
            type: "operation",
            operation: "stand_in.wait",
            timeout: "30d",
            input: { text: { value: "hello" } }
          },
          output
        ]
      };
      await save(t, manifest);
      const started = runSchema.parse(
        (
          await t.expectOk(t.root.id, "workflows.start", {
            params: { workflow: "waits" },
            payload: { input: {} }
          })
        ).json()
      );
      await expect(t.finish(started.id, undefined, 5)).rejects.toThrow("did not end");
      const step = (await stepRunsOf(t, started.id)).find((s) => s.stepId === "wait");
      expect(step?.status).toBe("waiting");
    } finally {
      await t.instance.close();
    }
  });
});
