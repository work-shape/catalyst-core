import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineToolDisplayWidget,
  toolDisplayWidgetRegistry,
  type StandardSchemaV1,
  type ToolDisplayRenderInput
} from "../packages/chat-ui/src/domain-ui-widgets";

describe("chat UI domain UI widgets", () => {
  it("declines rendering on version mismatch", () => {
    const widget = defineToolDisplayWidget({
      kind: "demo.count",
      version: 1,
      dataSchema: z.object({ count: z.number() }),
      render: () => "rendered"
    });

    expect(widget(createRenderInput({ version: 2, data: { count: 1 } }))).toBeUndefined();
  });

  it("declines rendering when data validation fails", () => {
    const widget = defineToolDisplayWidget({
      kind: "demo.count",
      version: 1,
      dataSchema: z.object({ count: z.number() }),
      render: () => "rendered"
    });

    expect(widget(createRenderInput({ data: { count: "1" } }))).toBeUndefined();
  });

  it("passes parsed data to the render function", () => {
    const renderedData: Array<{ count: number }> = [];
    const widget = defineToolDisplayWidget({
      kind: "demo.count",
      version: 1,
      dataSchema: z.object({ count: z.coerce.number() }),
      render: ({ data }) => {
        renderedData.push(data);
        return `count:${data.count}`;
      }
    });

    expect(widget(createRenderInput({ data: { count: "7" } }))).toBe("count:7");
    expect(renderedData).toEqual([{ count: 7 }]);
  });

  it("declines rendering for async Standard Schema validators", () => {
    const asyncSchema = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => Promise.resolve({ value: "ok" })
      }
    } satisfies StandardSchemaV1<unknown, string>;
    const widget = defineToolDisplayWidget({
      kind: "demo.async",
      version: 1,
      dataSchema: asyncSchema,
      render: ({ data }) => data
    });

    expect(widget(createRenderInput({ data: "ok" }))).toBeUndefined();
  });

  it("throws when registry builder receives duplicate widget kinds", () => {
    const firstWidget = defineToolDisplayWidget({
      kind: "demo.count",
      version: 1,
      dataSchema: z.object({ count: z.number() }),
      render: () => "first"
    });
    const secondWidget = defineToolDisplayWidget({
      kind: "demo.count",
      version: 1,
      dataSchema: z.object({ count: z.number() }),
      render: () => "second"
    });

    expect(() => toolDisplayWidgetRegistry(firstWidget, secondWidget)).toThrow(
      "Duplicate tool display widget kind: demo.count"
    );
  });
});

function createRenderInput({
  version = 1,
  data
}: {
  version?: number;
  data: unknown;
}): ToolDisplayRenderInput {
  return {
    display: {
      kind: "demo.count",
      version,
      data
    },
    locale: "en",
    source: "tool-result"
  };
}
