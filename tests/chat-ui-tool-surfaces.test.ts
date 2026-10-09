import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { toUiMessages } from "../packages/chat-ui/src/assistant/assistant-ui-adapter";
import { ToolDisplayPanelProvider } from "../packages/chat-ui/src/tool-display-panel";
import { ToolSurfaceList } from "../packages/chat-ui/src/tool-surface-card";
import { dedupeToolSurfaceRefs } from "../packages/chat-ui/src/tool-surfaces";

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

  it("does not render inert final surface cards for unsupported display payloads", () => {
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

    expect(markup).not.toContain("Unsupported Dashboard");
    expect(markup).not.toContain("button");
  });

  it("renders final surface cards as whole-card side panel openers", () => {
    const markup = renderToStaticMarkup(
      createElement(
        ToolDisplayPanelProvider,
        null,
        createElement(ToolSurfaceList, {
          surfaces: [
            {
              surfaceId: "surface_dashboard",
              title: "Dashboard",
              toolName: "show_view",
              display: {
                kind: "html.rendered",
                version: 1,
                mode: "side_panel",
                data: {
                  html: "<section>Dashboard</section>",
                  title: "Dashboard"
                }
              }
            }
          ]
        })
      )
    );

    expect(markup).toContain('role="button"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('aria-label="Open in side panel"');
    expect(markup).toContain("Dashboard");
  });

  it("renders structured data references as matching side-panel cards", () => {
    const markup = renderToStaticMarkup(
      createElement(
        ToolDisplayPanelProvider,
        null,
        createElement(ToolSurfaceList, {
          surfaces: [
            {
              surfaceId: "structured-data:resource_1",
              title: "Customer data",
              toolName: "structured_data.publish",
              display: {
                kind: "structured_data.resource",
                version: 1,
                mode: "side_panel",
                data: {
                  structuredDataResourceId: "resource_1",
                  resourceKey: "customer_data",
                  revision: 1
                }
              }
            }
          ]
        })
      )
    );

    expect(markup).toContain('role="button"');
    expect(markup).toContain("Customer data");
    expect(markup).not.toContain("structured_data.publish");
  });
});
