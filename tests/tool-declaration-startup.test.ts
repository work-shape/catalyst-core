import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance } from "./support/test-instance";

describe("what a tool must declare for an instance to start", () => {
  // A changing tool without a mode now uses the instance confirmation default.
  it("W1-8: rejects a missing effect and starts a changing tool using default confirmation", async () => {
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
    const app = await start(changing);
    await app.close();
  });
});
