import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCapability } from "@work-shape/catalyst-capability-sdk";
import { parseClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import { callableOperationsPageSchema, type OperationDefinition } from "@work-shape/catalyst-core";
import { createTestConfig } from "./support/fixtures";
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
