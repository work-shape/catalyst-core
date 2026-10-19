import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";
import { createInstanceSource, workflowGraph } from "@work-shape/catalyst-chat-ui/workflows";
import { recordedApiClient } from "./support/recorded-api-client";
const signal = new AbortController().signal;
const NOT_BUILT = {
  code: "not_supported_yet",
  message: "Cannot run this step",
  path: "steps[1].type"
};
const ASSET = {
  id: "asset_1",
  kind: "workflow",
  name: "month-end",
  scope: { kind: "instance" },
  revision: 1,
  publishedRevision: 1,
  updatedAt: "2026-10-19T00:00:00.000Z",
  config: { name: "month-end", manifest: { id: "month-end", name: "Month end", steps: [] } }
};

describe("WF-PANEL-1a the server's step facts on a real Workflow", () => {
  it("maps the Connection chip, service icon and effect from stepFacts through the instance source", async () => {
    const asset = {
      ...ASSET,
      stepFacts: {
        read: {
          effect: "reading",
          source: {
            kind: "connection",
            title: "Exampledata",
            service: "exampledata"
          }
        }
      },
      config: {
        ...ASSET.config,
        manifest: {
          ...ASSET.config.manifest,
          steps: [
            {
              id: "read",
              name: "Read bookings",
              type: "operation",
              operation: "connection.crm.echo",
              effect: "changing",
              source: "Wrong manifest source",
              service: "wrong"
            }
          ]
        }
      }
    };
    const calls = recordedApiClient(({ operation }) =>
      operation === "assets.get" ? asset : { items: [] }
    );
    const source = createInstanceSource(calls.client, "instance");
    const workflow = await source.getWorkflow("cw_1", "month-end", signal);
    expect(workflowGraph(workflow.steps, createTranslationContext("en")).nodes[0]?.chip).toEqual({
      label: "Exampledata",
      icon: "exampledata"
    });
    expect(workflow?.steps[0]).toMatchObject({
      source: "Exampledata",
      service: "exampledata",
      effect: "reading"
    });
  });

  it("keeps the step path on reasons when mapping the list", async () => {
    const calls = recordedApiClient(({ operation }) =>
      operation === "assets.get"
        ? ASSET
        : {
            items: [
              {
                id: "month-end",
                name: "Month end",
                definitionRevisionId: "r1",
                runnable: false,
                reasons: [NOT_BUILT],
                actions: [],
                inputs: {}
              }
            ]
          }
    );
    const source = createInstanceSource(calls.client, "instance");
    const workflow = await source.getWorkflow("cw_1", "month-end", signal);
    expect(workflow?.refusedFor).toEqual([NOT_BUILT]);
  });
});
