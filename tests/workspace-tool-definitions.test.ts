import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createWorkspaceToolDefinitions } from "@vivd-catalyst/tool-execution";
import { createTestInstance } from "./support/test-instance";

describe("workspace tool definitions", () => {
  it("offers the same tools, in the same order, with the same names, descriptions and schemas", async () => {
    const { stores } = await createTestInstance();

    const definitions = createWorkspaceToolDefinitions({ store: stores }).map((tool) => ({
      name: tool.name,
      description: tool.description,
      permission: tool.permission ?? null,
      inputJsonSchema: tool.inputJsonSchema,
      inputSchema: z.toJSONSchema(tool.inputSchema, { io: "input" }),
      outputSchema: tool.outputSchema ? z.toJSONSchema(tool.outputSchema) : null
    }));

    expect(JSON.stringify(definitions, null, 2)).toMatchSnapshot();
  });
});
