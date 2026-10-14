import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@vivd-catalyst/chat-ui";
import { assetToolSentence } from "@vivd-catalyst/chat-ui/asset-tool-lines";
import {
  savedDraftCalls,
  subjectOpenedInRun,
  subjectSurface,
  type SubjectRunPart
} from "@vivd-catalyst/chat-ui/subject-run";

const { t } = createTranslationContext("en");
const de = createTranslationContext("de").t;

function call(toolName: string, id: string, kind: string, name: string): SubjectRunPart {
  return {
    type: "tool_call",
    toolCallId: id,
    toolName,
    state: "output_available",
    output: { kind, name, title: name, config: {}, revision: 1, shows: "draft" }
  };
}
const opened = (id: string, kind: string, name: string) =>
  call("platform.assets.open", id, kind, name);
const read = (id: string, kind: string, name: string) =>
  call("platform.assets.get", id, kind, name);

describe("the subject a run opens", () => {
  it("is the asset of the last open that stood, whatever was read or refused after it", () => {
    const parts: SubjectRunPart[] = [
      opened("1", "workflow", "intake"),
      { type: "text" },
      opened("2", "app", "calculator"),
      // A read opens nothing, and an open the server refused leaves the conversation about
      // what it was.
      read("3", "agent", "helper"),
      {
        type: "tool_call",
        toolCallId: "4",
        toolName: "platform.assets.open",
        state: "output_error",
        output: { code: "handler_failed", message: "There is no such asset" }
      }
    ];

    expect(subjectOpenedInRun(parts)).toEqual({
      subject: { kind: "app", name: "calculator" },
      callId: "2"
    });
    expect(subjectOpenedInRun([{ type: "text" }])).toBeUndefined();
  });

  it("is nothing where the run only read assets", () => {
    expect(subjectOpenedInRun([read("1", "workflow", "intake")])).toBeUndefined();
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

  it("is the App a Page was kept as, and a save of its Page is a saved draft of it", () => {
    const keptAsApp: SubjectRunPart = {
      type: "tool_call",
      toolCallId: "5",
      toolName: "page.save_as_app",
      state: "output_available",
      output: { kind: "app", name: "offer-desk", title: "Offer desk", revision: 1 }
    };
    const pageSave = (id: string, app: unknown): SubjectRunPart => ({
      type: "tool_call",
      toolCallId: id,
      toolName: "page.save",
      state: "output_available",
      output: { pageId: "p1", fileSetId: `s${id}`, number: 2, ...(app ? { app } : {}) }
    });

    expect(subjectOpenedInRun([opened("1", "workflow", "intake"), keptAsApp])).toEqual({
      subject: { kind: "app", name: "offer-desk" },
      callId: "5"
    });
    expect(
      savedDraftCalls([
        pageSave("6", { name: "offer-desk", title: "Offer desk", saved: true, revision: 2 }),
        pageSave("7", { name: "offer-desk", title: "Offer desk", saved: false, message: "No" }),
        pageSave("8", undefined)
      ])
    ).toEqual(["6"]);
  });

  it("opens the canvas of a Workflow, the draft of an App and the saved state of an agent", () => {
    const surface = (kind: string) =>
      subjectSurface({ subject: { kind, name: "x" }, workspaceId: "w1", title: "X" });

    expect(surface("workflow")).toMatchObject({
      kind: "workflow_canvas",
      key: "subject:workflow:x",
      workspaceId: "w1",
      workflow: "x"
    });
    expect(surface("app")).toMatchObject({ kind: "app_edit", app: "x", workspaceId: "w1" });
    expect(surface("agent")).toMatchObject({ kind: "agent", agent: "x", title: "X" });
    // A Page opens through its own card; a kind without a surface opens nothing.
    expect(surface("page")).toBeUndefined();
    expect(surface("skill")).toBeUndefined();
  });
});

describe("the lines of the asset tools", () => {
  it("say which asset the agent opened, by its title, in English and German", () => {
    const answer = { kind: "workflow", name: "intake", title: "Customer intake" };
    expect(
      assetToolSentence({ toolName: "platform.assets.open", args: { kind: "workflow" } }, t)
    ).toBe("Opening the workflow…");
    expect(assetToolSentence({ toolName: "platform.assets.open", result: answer }, t)).toBe(
      "Opened Customer intake"
    );
    expect(assetToolSentence({ toolName: "platform.assets.open", result: answer }, de)).toBe(
      "Customer intake geöffnet"
    );
    expect(assetToolSentence({ toolName: "platform.assets.open", isError: true }, t)).toBe(
      "The asset could not be opened"
    );
  });

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

  it("say that the agent kept a Page as an App, in English and German", () => {
    const kept = { kind: "app", name: "offer-desk", title: "Offer desk", revision: 1 };
    expect(assetToolSentence({ toolName: "page.save_as_app" }, t)).toBe(
      "Saving the Page as an app…"
    );
    expect(assetToolSentence({ toolName: "page.save_as_app", result: kept }, t)).toBe(
      "Saved the Page as the app Offer desk"
    );
    expect(assetToolSentence({ toolName: "page.save_as_app", result: kept }, de)).toBe(
      "Page als App Offer desk gespeichert"
    );
    expect(assetToolSentence({ toolName: "page.save_as_app", isError: true }, t)).toBe(
      "The Page could not be saved as an app"
    );
  });

  it("leave every other tool to its own line", () => {
    expect(assetToolSentence({ toolName: "workspace.exec", result: {} }, t)).toBeUndefined();
  });
});
