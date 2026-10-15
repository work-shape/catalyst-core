import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@vivd-catalyst/chat-ui";
import { assetToolSentence } from "@vivd-catalyst/chat-ui/asset-tool-lines";
import {
  assetPageRoute,
  opensInRun,
  savedDraftCalls,
  standingAssetOpen,
  subjectOpenedInRun,
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

  it("leaves an open that waits for the person out of the subject, and keeps it among the opens", () => {
    const waiting: SubjectRunPart = {
      type: "tool_call",
      toolCallId: "2",
      toolName: "platform.assets.open",
      state: "output_available",
      output: { kind: "agent", name: "helper", title: "Helper", awaitsPerson: true }
    };
    const parts = [opened("1", "workflow", "intake"), waiting];

    expect(subjectOpenedInRun(parts)).toEqual({
      subject: { kind: "workflow", name: "intake" },
      callId: "1"
    });
    expect(opensInRun(parts)).toEqual([
      {
        subject: { kind: "workflow", name: "intake" },
        title: "intake",
        callId: "1",
        awaitsPerson: false
      },
      {
        subject: { kind: "agent", name: "helper" },
        title: "Helper",
        callId: "2",
        awaitsPerson: true
      }
    ]);
  });

  it("takes the first save that created an asset as its open, and no other save (NAV-2)", () => {
    const put = (id: string, output: unknown): SubjectRunPart => ({
      type: "tool_call",
      toolCallId: id,
      toolName: "platform.assets.put",
      state: "output_available",
      output
    });
    const created = {
      saved: true,
      revision: 1,
      created: true,
      kind: "workflow",
      name: "new-close",
      title: "New close"
    };
    const parts = [put("1", created), put("2", { saved: true, revision: 2 })];

    expect(opensInRun(parts)).toEqual([
      {
        subject: { kind: "workflow", name: "new-close" },
        title: "New close",
        callId: "1",
        awaitsPerson: false
      }
    ]);
    expect(subjectOpenedInRun(parts)).toEqual({
      subject: { kind: "workflow", name: "new-close" },
      callId: "1"
    });
    expect(savedDraftCalls(parts)).toEqual(["1", "2"]);
    expect(
      standingAssetOpen({ toolName: "platform.assets.put", toolCallId: "1", result: created })
    ).toMatchObject({ subject: { kind: "workflow", name: "new-close" }, title: "New close" });
    expect(
      standingAssetOpen({ toolName: "platform.assets.put", result: { saved: true, revision: 2 } })
    ).toBeUndefined();
    // A store the conversation's workspace owns says so: Studio reads it there.
    expect(
      standingAssetOpen({
        toolName: "platform.assets.put",
        toolCallId: "3",
        result: {
          saved: true,
          revision: 1,
          created: true,
          kind: "data_store",
          name: "orders",
          title: "Orders",
          workspaceId: "w1"
        }
      })
    ).toMatchObject({ subject: { kind: "data_store", name: "orders" }, owner: "w1" });
  });

  it("takes an open that stood as the line the thread shows, and nothing else", () => {
    const answer = { kind: "app", name: "calculator", title: "Calculator" };
    expect(
      standingAssetOpen({ toolName: "platform.assets.open", toolCallId: "c1", result: answer })
    ).toEqual({
      subject: { kind: "app", name: "calculator" },
      title: "Calculator",
      callId: "c1",
      awaitsPerson: false
    });
    expect(
      standingAssetOpen({ toolName: "platform.assets.open", result: answer, isError: true })
    ).toBeUndefined();
    expect(standingAssetOpen({ toolName: "platform.assets.open" })).toBeUndefined();
    expect(standingAssetOpen({ toolName: "platform.assets.get", result: answer })).toBeUndefined();
  });

  it("leads a Workflow, an App, an agent, a skill and a Data Store to their own pages", () => {
    const page = (kind: string) => assetPageRoute({ kind, name: "x" }, "w1");

    expect(page("workflow")).toEqual({
      kind: "workflow",
      collaborationWorkspaceId: "w1",
      workflow: "x"
    });
    expect(page("app")).toEqual({ kind: "app-edit", collaborationWorkspaceId: "w1", app: "x" });
    expect(page("agent")).toEqual({ kind: "build-asset", assetKind: "agents", name: "x" });
    expect(page("skill")).toEqual({ kind: "build-asset", assetKind: "skills", name: "x" });
    expect(page("data_store")).toEqual({
      kind: "build-asset",
      assetKind: "data-stores",
      name: "x"
    });
    // A kind without a page of its own leads nowhere; a workspace's page needs the workspace.
    expect(page("page")).toBeUndefined();
    expect(assetPageRoute({ kind: "workflow", name: "x" }, undefined)).toBeUndefined();
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
