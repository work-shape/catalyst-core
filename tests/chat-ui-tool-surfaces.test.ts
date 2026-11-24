import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { toUiMessages, ToolSurfaceList, dedupeToolSurfaceRefs } from "./support/chat-ui";
import {
  createToolDisplayPanelAutoShowTracker,
  ToolDisplayPanelProvider
} from "@work-shape/catalyst-chat-ui/tool-display-panel";

describe("chat UI message history projection", () => {
  it("defers promoted result cards until the active run finishes", () => {
    const projected = toUiMessages([], {
      run: {
        id: "run_active",
        status: "running"
      },
      projection: {
        runId: "run_active",
        lastSequence: 3,
        status: "running",
        text: "",
        reasoning: [],
        activeToolCalls: [],
        parts: [
          {
            type: "tool_call",
            toolCallId: "call_review",
            toolName: "submit_review",
            input: {},
            state: "output_available",
            output: {
              status: "success",
              display: {
                kind: "review.result",
                version: 1,
                mode: "side_panel",
                title: "Review",
                data: {}
              }
            }
          }
        ]
      }
    });

    expect(projected[0]?.parts).not.toContainEqual(
      expect.objectContaining({ type: "data-workspace-promoted-surfaces" })
    );
  });

  it("surfaces side-panel displays while a completed run is still active", () => {
    const projected = toUiMessages([], {
      run: {
        id: "run_active",
        status: "completed"
      },
      projection: {
        runId: "run_active",
        lastSequence: 4,
        status: "completed",
        text: "The review is ready.",
        reasoning: [],
        activeToolCalls: [],
        parts: [
          {
            type: "tool_call",
            toolCallId: "call_review",
            toolName: "submit_review",
            input: {},
            state: "output_available",
            output: {
              status: "success",
              display: {
                kind: "review.result",
                version: 1,
                mode: "side_panel",
                title: "Review",
                data: {}
              }
            }
          },
          {
            type: "text",
            text: "The review is ready."
          }
        ]
      }
    });

    expect(projected[0]?.metadata).toEqual({
      custom: {
        source: "active-run",
        activeRunCompleted: true
      }
    });
    expect(projected[0]?.parts).toContainEqual({
      type: "data-workspace-promoted-surfaces",
      data: {
        kind: "workspace.promoted_surfaces",
        surfaces: [
          {
            surfaceId: "tool:call_review",
            toolCallId: "call_review",
            toolName: "submit_review",
            title: "Review",
            display: {
              kind: "review.result",
              version: 1,
              mode: "side_panel",
              title: "Review",
              data: {}
            }
          }
        ]
      }
    });
  });

  it("keeps the latest revision for repeated promoted surface ids", () => {
    expect(
      dedupeToolSurfaceRefs([
        {
          surfaceId: "structured-data:resource_1",
          title: "Customer data",
          display: {
            kind: "structured_data.resource",
            version: 1,
            data: {
              structuredDataResourceId: "resource_1",
              revision: 1
            }
          }
        },
        {
          surfaceId: "structured-data:resource_1",
          title: "Updated customer data",
          display: {
            kind: "structured_data.resource",
            version: 1,
            data: {
              structuredDataResourceId: "resource_1",
              revision: 2
            }
          }
        }
      ])
    ).toEqual([
      expect.objectContaining({
        title: "Updated customer data",
        display: expect.objectContaining({
          data: expect.objectContaining({ revision: 2 })
        })
      })
    ]);
  });

  it("opens a final surface of a kind without a widget in the generic data view", () => {
    // Its data is read from its own shape (TOOL-2), so the card has something to open.
    const markup = renderToStaticMarkup(
      createElement(
        ToolDisplayPanelProvider,
        null,
        createElement(ToolSurfaceList, {
          surfaces: [
            {
              surfaceId: "surface_unsupported",
              title: "Unsupported Dashboard",
              toolName: "show_view",
              display: {
                kind: "custom.unsupported",
                version: 1,
                mode: "side_panel",
                data: {
                  title: "Unsupported Dashboard"
                }
              }
            }
          ]
        })
      )
    );

    expect(markup).toContain("Unsupported Dashboard");
    expect(markup).toContain("Open in side panel");
  });
});

describe("chat UI tool display panel", () => {
  it("auto-opens each display key once", () => {
    const tracker = createToolDisplayPanelAutoShowTracker();

    expect(tracker.shouldAutoShow("review:call_1")).toBe(true);
    expect(tracker.shouldAutoShow("review:call_1")).toBe(false);
    expect(tracker.shouldAutoShow("review:call_2")).toBe(true);
  });
});
