import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@vivd-catalyst/chat-ui";
import { assetToolSentence } from "@vivd-catalyst/chat-ui/asset-tool-lines";
import {
  savedDraftCalls,
  subjectReadInRun,
  subjectSurface,
  type SubjectRunPart
} from "@vivd-catalyst/chat-ui/subject-run";

const { t } = createTranslationContext("en");
const de = createTranslationContext("de").t;

function read(id: string, kind: string, name: string): SubjectRunPart {
  return {
    type: "tool_call",
    toolCallId: id,
    toolName: "platform.assets.get",
    state: "output_available",
    output: { kind, name, config: {}, revision: 1, shows: "draft" }
  };
}

describe("the subject a run reads", () => {
  it("is the asset of the last read that stood, whatever was refused after it", () => {
    const parts: SubjectRunPart[] = [
      read("1", "workflow", "intake"),
      { type: "text" },
      read("2", "app", "calculator"),
      // A read the server refused leaves the conversation about what it was.
      {
        type: "tool_call",
        toolCallId: "3",
        toolName: "platform.assets.get",
        state: "output_error",
        output: { code: "handler_failed", message: "There is no such asset" }
      }
    ];

    expect(subjectReadInRun(parts)).toEqual({ kind: "app", name: "calculator" });
    expect(subjectReadInRun([{ type: "text" }])).toBeUndefined();
  });

  it("counts only the saves that stored a revision", () => {
    const put = (id: string, output: unknown): SubjectRunPart => ({
      type: "tool_call",
      toolCallId: id,
      toolName: "platform.assets.put",
      state: "output_available",
      output
    });

    expect(
      savedDraftCalls([
        put("1", { saved: true, revision: 4 }),
        put("2", { saved: false, issues: [{ path: "steps", message: "Empty" }] }),
        { ...put("3", undefined), state: "input_available" },
        put("4", { output: { saved: true, revision: 5 } })
      ])
    ).toEqual(["1", "4"]);
  });

  it("opens the canvas of a Workflow", () => {
    const surface = (kind: string) =>
      subjectSurface({ subject: { kind, name: "x" }, workspaceId: "w1", title: "X" });

    expect(surface("workflow")).toMatchObject({
      kind: "workflow_canvas",
      key: "subject:workflow:x",
      workspaceId: "w1",
      workflow: "x"
    });
    // A Page opens through its own card; a kind without a surface opens nothing.
    expect(surface("page")).toBeUndefined();
    expect(surface("skill")).toBeUndefined();
    expect(surface("app")).toBeUndefined();
  });
});

describe("the lines of the asset tools", () => {
  it("say what the agent did to the asset, in English and German", () => {
    expect(
      assetToolSentence(
        { toolName: "platform.assets.get", args: { kind: "workflow" }, result: undefined },
        t
      )
    ).toBe("Reading the workflow…");
    expect(
      assetToolSentence(
        { toolName: "platform.assets.get", result: { kind: "agent", name: "a" } },
        t
      )
    ).toBe("Read the agent");
    expect(
      assetToolSentence({ toolName: "platform.assets.validate", result: { issues: [] } }, t)
    ).toBe("Checked the draft: no problems");
    expect(
      assetToolSentence({ toolName: "platform.assets.validate", result: { issues: [{}, {}] } }, t)
    ).toBe("Checked the draft: 2 problems");
    expect(
      assetToolSentence(
        { toolName: "platform.assets.put", result: { saved: true, revision: 5 } },
        t
      )
    ).toBe("Saved revision 5");
    expect(
      assetToolSentence(
        { toolName: "platform.assets.put", result: { saved: true, revision: 5 } },
        de
      )
    ).toBe("Revision 5 gespeichert");
    expect(
      assetToolSentence(
        { toolName: "platform.assets.put", result: { saved: false, issues: [{}] } },
        t
      )
    ).toBe("Not saved: 1 problem");
    expect(
      assetToolSentence(
        {
          toolName: "platform.assets.put",
          result: { saved: false, conflict: "REVISION_CONFLICT" }
        },
        t
      )
    ).toBe("Someone saved in between: reading again");
    expect(assetToolSentence({ toolName: "platform.assets.get", isError: true }, t)).toBe(
      "The asset could not be read"
    );
  });

  it("leave every other tool to its own line", () => {
    expect(assetToolSentence({ toolName: "workspace.exec", result: {} }, t)).toBeUndefined();
  });
});
