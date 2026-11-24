import { describe, expect, it } from "vitest";
import { z } from "zod";
import { appActionInputAsZod } from "@work-shape/catalyst-app-build";
import { withoutCheckFormats, type JsonObject } from "@work-shape/catalyst-core";
import { deriveInputJsonSchema } from "@work-shape/catalyst-tool-sdk";

describe("schemas a model is shown", () => {
  const input = z.object({
    path: z.string().startsWith("/"),
    nested: z.array(z.object({ name: z.string().endsWith(".md").nullable() })),
    mail: z.email()
  });

  it("derives a tool schema without Zod's check names and with their patterns", () => {
    const derived = deriveInputJsonSchema(input);
    const shown = JSON.stringify(derived);

    expect(shown).not.toContain("starts_with");
    expect(shown).not.toContain("ends_with");
    expect(derived.properties).toMatchObject({
      path: { type: "string", pattern: expect.any(String) },
      mail: { format: "email" }
    });
  });

  it("leaves out check names from a schema written elsewhere", () => {
    const schema: JsonObject = {
      type: "object",
      properties: { path: { type: "string", format: "starts_with", pattern: "^/.*" } }
    };

    expect(withoutCheckFormats(schema)).toEqual({
      type: "object",
      properties: { path: { type: "string", pattern: "^/.*" } }
    });
  });

  it("keeps a property named format and data that reads like a check", () => {
    const schema: JsonObject = {
      type: "object",
      properties: {
        format: { type: "string", enum: ["starts_with"], default: "starts_with" }
      },
      examples: [{ format: "starts_with" }]
    };

    expect(withoutCheckFormats(schema)).toEqual(schema);
  });
});

describe("a date-time parameter of an app action", () => {
  const read = appActionInputAsZod({
    type: "object",
    properties: { at: { type: "string", format: "date-time" } },
    required: ["at"]
  });

  it.each([
    "2026-09-30T12:00:00Z",
    "2026-09-30T12:00Z",
    "2026-09-30T12:00+02:00",
    "2026-09-30T12:00"
  ])("takes %s", (at) => {
    expect(read.parse({ at })).toEqual({ at });
  });

  it("refuses text that is no moment", () => {
    expect(read.safeParse({ at: "yesterday" }).success).toBe(false);
  });
});
