import { describe, expect, it } from "vitest";
import type { GroupByContext, PartState } from "@assistant-ui/react";
import {
  ASSISTANT_WORK_GROUP,
  countAssistantWorkTimelineSteps,
  createCompletedAssistantWorkIndices,
  createAssistantWorkTimelineItems,
  createAssistantMessageGroupBy,
  createRenderableAssistantToolGroupIndices,
  createVisibleFinalAssistantPartIndices,
  findFinalAssistantTextPartIndex
} from "../packages/chat-ui/src/chat/assistant/assistant-work-grouping";

describe("assistant work grouping", () => {
  it("uses the last non-empty text part as the visible final answer boundary", () => {
    expect(
      findFinalAssistantTextPartIndex([
        textPart("Working"),
        toolPart("call_lookup"),
        textPart("Final answer"),
        dataPart()
      ])
    ).toBe(2);
  });

  it("keeps completed progress chronological and only groups tool work", () => {
    const parts = [
      textPart("I will inspect the file."),
      toolPart("call_import"),
      textPart("The file has 13 slides."),
      toolPart("call_read"),
      textPart("Final answer."),
      dataPart()
    ];

    expect(groupPaths(parts)).toEqual([
      [],
      [ASSISTANT_WORK_GROUP],
      [],
      [ASSISTANT_WORK_GROUP],
      [],
      []
    ]);
  });

  it("keeps chronological progress parts while a message is still running", () => {
    const parts = [
      textPart("I will inspect the file."),
      toolPart("call_import"),
      textPart("I am checking the extracted content."),
      toolPart("call_read")
    ];

    expect(groupPaths(parts)).toEqual([[], [ASSISTANT_WORK_GROUP], [], [ASSISTANT_WORK_GROUP]]);
  });

  it("does not collapse normal text-only assistant answers", () => {
    expect(groupPaths([textPart("Final answer.")])).toEqual([[]]);
  });

  it("keeps source-only parts after the final text uncounted as work steps", () => {
    const parts = [textPart("Final answer."), sourcePart("web_source_1")];
    const workIndices = createCompletedAssistantWorkIndices(parts, 0);
    const items = createAssistantWorkTimelineItems(parts, workIndices);

    expect(findFinalAssistantTextPartIndex(parts)).toBe(0);
    expect(workIndices).toEqual([1]);
    expect(items).toEqual([{ type: "source-group", indices: [1] }]);
    expect(countAssistantWorkTimelineSteps(items)).toBe(0);
    expect(createVisibleFinalAssistantPartIndices(parts, 0)).toEqual([0]);
  });

  it("keeps the card of a saved Page revision under the answer and folds a refused save away", () => {
    // Fails without the Page surface: every page.save call folded into the work summary, and
    // with it the only way to open the revision again.
    const saved = {
      type: "tool-call" as const,
      toolCallId: "call_saved",
      toolName: "page.save",
      args: { name: "Offers", directory: "offers" },
      result: { output: { pageId: "page-1", number: 1, fileSetId: "set-1" } }
    };
    const refused = {
      ...saved,
      toolCallId: "call_refused",
      result: { output: { errors: [{ file: "app.yaml", message: "No kit version." }] } }
    };
    const parts = [refused, saved, textPart("The Page is ready.")];

    expect(createCompletedAssistantWorkIndices(parts, 2)).toEqual([0]);
    expect(createVisibleFinalAssistantPartIndices(parts, 2)).toEqual([2, 1]);
  });

  it("shows a save on its own while the run goes on", () => {
    // Fails without the rule for page.save: the call folded into "1 tool call", and nothing in
    // the thread said that a Page was being built.
    const parts = [
      toolPart("call_patch", "workspace.apply_patch"),
      toolPart("call_save", "page.save")
    ];

    expect(groupPaths(parts)).toEqual([[ASSISTANT_WORK_GROUP], []]);
  });

  it("keeps every open of an asset that stood in the thread, during and after the run", () => {
    // Fails without the rule for opens: the line "Opened <name>" folded into "2 tool calls", and
    // a change of what the conversation is about was not seen (navigation check 27).
    const opened = openPart("call_open", { kind: "workflow", name: "intake", title: "Intake" });
    const refused = openPart("call_refused", undefined, true);
    const parts = [
      toolPart("call_read", "platform.assets.get"),
      opened,
      refused,
      textPart("Done.")
    ];

    expect(groupPaths(parts.slice(0, 3))).toEqual([
      [ASSISTANT_WORK_GROUP],
      [],
      [ASSISTANT_WORK_GROUP]
    ]);
    expect(createCompletedAssistantWorkIndices(parts, 3)).toEqual([0, 2]);
    expect(createVisibleFinalAssistantPartIndices(parts, 3)).toEqual([3, 1]);
  });

  it("keeps the card of a refused save when the answer ended with it", () => {
    // Fails without the rule for the last save: the card folded into the work summary, and an
    // answer whose Page was never built showed nothing of what the build found.
    const refused = {
      type: "tool-call" as const,
      toolCallId: "call_refused",
      toolName: "page.save",
      args: { name: "Offers", directory: "offers" },
      result: { output: { errors: [{ file: "app.yaml", message: "No kit version." }] } }
    };
    const parts = [
      { ...refused, toolCallId: "call_first" },
      refused,
      textPart("The Page could not be built.")
    ];

    expect(createCompletedAssistantWorkIndices(parts, 2)).toEqual([0]);
    expect(createVisibleFinalAssistantPartIndices(parts, 2)).toEqual([2, 1]);
  });

  it("keeps web search tool work and source parts collapsible as one step", () => {
    const parts = [
      textPart("Final answer."),
      toolPart("web_search:msg_final", "web_search"),
      sourcePart("web_source_1"),
      sourcePart("web_source_2")
    ];

    const workIndices = createCompletedAssistantWorkIndices(parts, 0);
    const items = createAssistantWorkTimelineItems(parts, workIndices);

    expect(workIndices).toEqual([1, 2, 3]);
    expect(createVisibleFinalAssistantPartIndices(parts, 0)).toEqual([0]);
    expect(items).toEqual([
      { type: "tool-group", indices: [1] },
      { type: "source-group", indices: [2, 3] }
    ]);
    expect(countAssistantWorkTimelineSteps(items)).toBe(1);
  });

  it("deduplicates repeated tool-call parts before counting visible tool rows", () => {
    const parts = [
      textPart("Checking."),
      toolPart("call_web", "web_search"),
      toolPart("call_web", "web_search"),
      toolPart("call_policy", "web_search"),
      sourcePart("web_source_1"),
      textPart("Final answer.")
    ];
    const workIndices = createCompletedAssistantWorkIndices(parts, 5);
    const toolGroup = createAssistantWorkTimelineItems(parts, workIndices).find(
      (item) => item.type === "tool-group"
    );

    expect(toolGroup).toEqual({ type: "tool-group", indices: [1, 2, 3] });
    expect(createRenderableAssistantToolGroupIndices(parts, [1, 2, 3])).toEqual([2, 3]);
  });

  it("does not count completed reasoning as a visible work or tool row", () => {
    const parts = [
      textPart("I will check the rules."),
      reasoningPart("Searching official sources."),
      toolPart("call_web", "web_search"),
      reasoningPart("Reviewing sources."),
      textPart("Final answer.")
    ];
    const workIndices = createCompletedAssistantWorkIndices(parts, 4);
    const items = createAssistantWorkTimelineItems(parts, workIndices);

    expect(items).toEqual([
      { type: "part", index: 0 },
      { type: "tool-group", indices: [2] }
    ]);
    expect(countAssistantWorkTimelineSteps(items)).toBe(2);
    expect(createRenderableAssistantToolGroupIndices(parts, [1, 2, 3])).toEqual([2]);
  });

  it("drops reasoning-only completed work instead of rendering an empty tool group", () => {
    const parts = [reasoningPart("Thinking."), textPart("Final answer.")];
    const workIndices = createCompletedAssistantWorkIndices(parts, 1);

    expect(createAssistantWorkTimelineItems(parts, workIndices)).toEqual([]);
    expect(
      countAssistantWorkTimelineSteps(createAssistantWorkTimelineItems(parts, workIndices))
    ).toBe(0);
    expect(createRenderableAssistantToolGroupIndices(parts, [0])).toEqual([]);
  });

  it("keeps visible tools compact when only hidden completed reasoning separates them", () => {
    const parts = [
      toolPart("call_first"),
      reasoningPart("Internal reasoning between tools."),
      toolPart("call_second"),
      textPart("Final answer.")
    ];
    const workIndices = createCompletedAssistantWorkIndices(parts, 3);

    expect(createAssistantWorkTimelineItems(parts, workIndices)).toEqual([
      { type: "tool-group", indices: [0, 2] }
    ]);
    expect(
      countAssistantWorkTimelineSteps(createAssistantWorkTimelineItems(parts, workIndices))
    ).toBe(1);
    expect(createRenderableAssistantToolGroupIndices(parts, [0, 1, 2])).toEqual([0, 2]);
  });

  it("keeps final promoted artifact parts visible with the final answer", () => {
    const parts = [
      textPart("I will create the file."),
      toolPart("call_create"),
      textPart("The file is ready."),
      promotedArtifactsPart()
    ];

    expect(findFinalAssistantTextPartIndex(parts)).toBe(2);
    expect(createCompletedAssistantWorkIndices(parts, 2)).toEqual([0, 1]);
    expect(createVisibleFinalAssistantPartIndices(parts, 2)).toEqual([2, 3]);
  });

  it("keeps final promoted display surfaces visible with the final answer", () => {
    const parts = [
      textPart("I will create a dashboard."),
      toolPart("call_view", "show_view"),
      textPart("The dashboard is ready."),
      promotedSurfacesPart()
    ];

    expect(findFinalAssistantTextPartIndex(parts)).toBe(2);
    expect(createCompletedAssistantWorkIndices(parts, 2)).toEqual([0, 1]);
    expect(createVisibleFinalAssistantPartIndices(parts, 2)).toEqual([2, 3]);
  });

  it("keeps standalone tool UIs outside the collapsed work group", () => {
    const parts = [toolPart("call_view", "show_view"), textPart("Final answer.")];

    expect(
      groupPaths(parts, {
        toolUIs: {
          show_view: [{ render: () => null, standalone: true }]
        }
      })
    ).toEqual([[], []]);
  });

  it("keeps tool-only messages grouped when there is no final text part yet", () => {
    expect(groupPaths([toolPart("call_lookup")])).toEqual([[ASSISTANT_WORK_GROUP]]);
  });

  it("keeps old chronological tool summaries inside the completed work timeline", () => {
    const parts = [
      textPart("I will inspect the file."),
      toolPart("call_import"),
      toolPart("call_read"),
      textPart("I found the issue."),
      dataPart(),
      toolPart("call_fix"),
      textPart("Final answer.")
    ];

    expect(createAssistantWorkTimelineItems(parts, [0, 1, 2, 3, 4, 5])).toEqual([
      { type: "part", index: 0 },
      { type: "tool-group", indices: [1, 2] },
      { type: "part", index: 3 },
      { type: "part", index: 4 },
      { type: "tool-group", indices: [5] }
    ]);
  });

  it("keeps standalone tool UIs as direct timeline entries inside completed work", () => {
    const parts = [
      textPart("Opening the widget."),
      toolPart("call_view", "show_view"),
      toolPart("call_lookup"),
      textPart("Final answer.")
    ];

    expect(
      createAssistantWorkTimelineItems(parts, [0, 1, 2], {
        toolUIs: {
          show_view: [{ render: () => null, standalone: true }]
        }
      })
    ).toEqual([
      { type: "part", index: 0 },
      { type: "part", index: 1 },
      { type: "tool-group", indices: [2] }
    ]);
  });
});

function groupPaths(
  parts: PartState[],
  context: GroupByContext = {}
): readonly (readonly string[])[] {
  const groupBy = createAssistantMessageGroupBy();
  return parts.map((part) => groupBy(part, context));
}

function textPart(text: string): PartState {
  return {
    type: "text",
    text,
    status: { type: "complete" }
  } as PartState;
}

function toolPart(toolCallId: string, toolName = "demo.lookup"): PartState {
  return {
    type: "tool-call",
    toolCallId,
    toolName,
    args: {},
    argsText: "{}",
    status: { type: "complete" }
  } as PartState;
}

function openPart(toolCallId: string, result: unknown, isError = false): PartState {
  return {
    type: "tool-call",
    toolCallId,
    toolName: "platform.assets.open",
    args: {},
    argsText: "{}",
    result,
    isError,
    status: { type: "complete" }
  } as PartState;
}

function reasoningPart(text: string): PartState {
  return {
    type: "reasoning",
    text,
    status: { type: "complete" }
  } as PartState;
}

function dataPart(): PartState {
  return {
    type: "data",
    name: "display",
    data: {},
    status: { type: "complete" }
  } as PartState;
}

function promotedArtifactsPart(): PartState {
  return {
    type: "data",
    name: "data-workspace-promoted-artifacts",
    data: {
      kind: "workspace.promoted_artifacts",
      artifacts: [
        {
          artifactId: "art_docx",
          filename: "tiny_museum.docx",
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        }
      ]
    },
    status: { type: "complete" }
  } as PartState;
}

function promotedSurfacesPart(): PartState {
  return {
    type: "data",
    name: "data-workspace-promoted-surfaces",
    data: {
      kind: "workspace.promoted_surfaces",
      surfaces: [
        {
          surfaceId: "tool:call_view",
          title: "Dashboard",
          display: {
            kind: "html.rendered",
            version: 1,
            mode: "inline",
            data: {
              title: "Dashboard",
              html: "<section>Dashboard</section>"
            }
          }
        }
      ]
    },
    status: { type: "complete" }
  } as PartState;
}

function sourcePart(sourceId: string): PartState {
  return {
    type: "source",
    sourceType: "url",
    id: sourceId,
    url: "https://example.com/report",
    status: { type: "complete" }
  } as PartState;
}
