import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance } from "./support/test-instance";

describe("what a tool must declare for an instance to start", () => {
  // Fails before the fix: a tool without an effect started with the instance and every call
  // of it ended as INTERNAL; a changing tool without a mode ran as if it had said `allow`.
  it("rejects startup for a tool without an effect, and for a changing tool without a mode, by name", async () => {
    const changing = defineTool({
      name: "demo.modeless",
      effect: "changing",
      description: "Changes something and names no permission mode.",
      inputSchema: z.object({}),
      execute: () => toolSuccess({})
    });
    const start = (tool: typeof changing) =>
      createTestInstance({
        config: createTestConfig({
          tools: [{ name: tool.name, enabled: true }],
          toolNames: [tool.name]
        }),
        env: {},
        tools: [tool]
      });

    await expect(
      start(Object.assign({}, changing, { name: "demo.effectless", effect: undefined }))
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "Client instance assembly is invalid",
      details: {
        issues: [
          {
            message:
              "Tool 'demo.effectless' declares no effect. Declare effect 'reading' or 'changing' in its definition."
          }
        ]
      }
    });
    await expect(start(changing)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: {
        issues: [
          {
            message:
              "Tool 'demo.modeless' declares no permission mode, so the instance default 'confirm' for changing calls applies, and an agent's call cannot wait for a person yet. Declare permission.mode 'allow' or 'deny' on the tool, or set policy.defaults.changing."
          }
        ]
      }
    });
  });
});
