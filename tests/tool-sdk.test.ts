import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool } from "@vivd-catalyst/tool-sdk";

describe("tool SDK", () => {
  it("derives provider-facing input JSON Schema from Zod input schemas", () => {
    const tool = defineTool({
      name: "test.representative",
      description: "Representative test tool.",
      inputSchema: z.object({
        title: z.string().min(2).max(40).describe("Short user-visible title."),
        count: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(3)
          .describe("Number of items to include."),
        mode: z.enum(["fast", "thorough"]).default("fast").describe("Execution mode."),
        code: z
          .string()
          .regex(/^AB-\d{3}$/u)
          .describe("Optional tracking code.")
          .optional()
      }),
      execute() {
        return { status: "success", output: {} };
      }
    });

    expect(tool.inputJsonSchema).toEqual({
      type: "object",
      properties: {
        title: {
          type: "string",
          minLength: 2,
          maxLength: 40,
          description: "Short user-visible title."
        },
        count: {
          default: 3,
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "Number of items to include."
        },
        mode: {
          default: "fast",
          type: "string",
          enum: ["fast", "thorough"],
          description: "Execution mode."
        },
        code: {
          type: "string",
          pattern: "^AB-\\d{3}$",
          description: "Optional tracking code."
        }
      },
      required: ["title"],
      additionalProperties: false
    });
  });

  it("keeps record value schemas in additionalProperties instead of closing them", () => {
    const tool = defineTool({
      name: "test.record_input",
      description: "Tool with a record-typed input field.",
      inputSchema: z.object({
        labels: z.record(z.string(), z.string()).describe("Arbitrary string labels.")
      }),
      execute() {
        return { status: "success", output: {} };
      }
    });

    const labels = (tool.inputJsonSchema.properties as Record<string, Record<string, unknown>>).labels;
    expect(labels.type).toBe("object");
    expect(labels.additionalProperties).toEqual({ type: "string" });
    expect(tool.inputJsonSchema.additionalProperties).toBe(false);
  });
});
