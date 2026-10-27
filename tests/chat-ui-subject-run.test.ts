import { describe, expect, it } from "vitest";
import { createTranslationContext } from "./support/chat-ui/shared";
import { assetToolSentence } from "@work-shape/catalyst-chat-ui/asset-tool-lines";
import {
  assetPageRoute,
  opensInRun,
  publishedCalls,
  rowWriteCalls,
  savedDraftCalls,
  standingAssetOpen,
  subjectOpenedInRun,
  type SubjectRunPart
} from "@work-shape/catalyst-chat-ui/subject-run";

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

  // BUILD-ALL-1: a draft created while the conversation is about another asset opens nothing.
  it("stays the subject where a save created a draft beside it, whose line says it was created", () => {
    const createdBeside: SubjectRunPart = {
      type: "tool_call",
      toolCallId: "2",
      toolName: "platform.assets.put",
      state: "output_available",
      output: {
        saved: true,
        revision: 1,
        created: true,
        kind: "workflow",
        name: "invoice-check",
        title: "Invoice check",
        besideSubject: true
      }
    };
    const parts = [opened("1", "app", "invoice-desk"), createdBeside];

    expect(subjectOpenedInRun(parts)).toEqual({
      subject: { kind: "app", name: "invoice-desk" },
      callId: "1"
    });
    expect(opensInRun([createdBeside])).toEqual([]);
    expect(savedDraftCalls(parts)).toEqual(["2"]);
    expect(
      standingAssetOpen({
        toolName: "platform.assets.put",
        toolCallId: "2",
        result: createdBeside.output
      })
    ).toEqual({
      subject: { kind: "workflow", name: "invoice-check" },
      title: "Invoice check",
      callId: "2",
      awaitsPerson: false,
      besideSubject: true
    });
    expect(t("conversationCreatedWorkflow", { name: "Invoice check" })).toBe(
      "Workflow draft “Invoice check” created"
    );
    expect(de("conversationCreatedWorkflow", { name: "Rechnungsprüfung" })).toBe(
      "Workflow-Entwurf „Rechnungsprüfung“ erstellt"
    );
    expect(de("conversationCreatedDataStore", { name: "Belege" })).toBe(
      "Datenspeicher-Entwurf „Belege“ erstellt"
    );
    expect(de("conversationCreatedOpen")).toBe("Öffnen");
  });

  it("is the App the first app.save made, and a later app.save is a saved draft of it", () => {
    const appSave = (id: string, output: unknown): SubjectRunPart => ({
      type: "tool_call",
      toolCallId: id,
      toolName: "app.save",
      state: "output_available",
      output
    });
    const app = { kind: "app", name: "offer-desk", title: "Offer desk" };
    const made = appSave("5", { ...app, saved: true, created: true, revision: 1 });
    const next = appSave("6", { ...app, saved: true, created: false, revision: 2 });
    const unchanged = appSave("7", { ...app, saved: false, message: "No" });

    expect(subjectOpenedInRun([opened("1", "workflow", "intake"), made])).toEqual({
      subject: { kind: "app", name: "offer-desk" },
      callId: "5"
    });
    // A later save opens nothing new: the conversation is about the App already.
    expect(subjectOpenedInRun([next, unchanged])).toBeUndefined();
    expect(savedDraftCalls([made, next, unchanged])).toEqual(["5", "6"]);
  });

  // Check 54 of apps-and-pages: the calls of the former names in a stored conversation still
  // read as what they did.
  it("is the App a call of the former page.save_as_app made, and a former page.save that wrote it a saved draft", () => {
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
    ).toBe("Draft saved");
    expect(
      assetToolSentence(
        { toolName: "platform.assets.put", result: { saved: true, revision: 5 } },
        de
      )
    ).toBe("Entwurf gespeichert");
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

  it("say that the agent saved an App or its draft, in English and German, also for the former name", () => {
    const app = { kind: "app", name: "offer-desk", title: "Offer desk" };
    const made = { ...app, saved: true, created: true, revision: 1 };
    expect(assetToolSentence({ toolName: "app.save" }, t)).toBe("Saving as an app…");
    expect(assetToolSentence({ toolName: "app.save", result: made }, t)).toBe(
      "Saved as the app Offer desk"
    );
    expect(assetToolSentence({ toolName: "app.save", result: made }, de)).toBe(
      "Als App Offer desk gespeichert"
    );
    expect(
      assetToolSentence(
        { toolName: "app.save", result: { ...app, saved: true, created: false, revision: 2 } },
        t
      )
    ).toBe("Saved to the draft of Offer desk");
    expect(
      assetToolSentence(
        { toolName: "app.save", result: { ...app, saved: false, message: "No" } },
        de
      )
    ).toBe("Der Entwurf von Offer desk wurde nicht geändert");
    expect(assetToolSentence({ toolName: "app.save", isError: true }, t)).toBe(
      "The app could not be saved"
    );
    const kept = { kind: "app", name: "offer-desk", title: "Offer desk", revision: 1 };
    expect(assetToolSentence({ toolName: "page.save_as_app", result: kept }, t)).toBe(
      "Saved as the app Offer desk"
    );
  });

  it("leave every other tool to its own line", () => {
    expect(assetToolSentence({ toolName: "workspace.exec", result: {} }, t)).toBeUndefined();
  });
});

// E-1: what the agent made live or wrote while the person watches drops the reads that show it,
// so the Workflow page, the App and the store's rows follow the conversation.
describe("the calls of a run that change what pages show", () => {
  const answered = (toolName: string, id: string, state = "output_available"): SubjectRunPart => ({
    type: "tool_call",
    toolCallId: id,
    toolName,
    state,
    output: { ok: true }
  });

  it("names each publish that answered, and no publish still waiting or refused", () => {
    expect(
      publishedCalls([
        answered("assets.publish", "1"),
        answered("assets.publish", "2", "approval-requested"),
        answered("assets.publish", "3", "output_error"),
        answered("platform.assets.put", "4")
      ])
    ).toEqual(["1"]);
  });

  it("names each row write that answered, and no read or other operation of the store", () => {
    expect(
      rowWriteCalls([
        answered("data_store.findings.insert", "1"),
        answered("data_store.findings.update", "2"),
        answered("data_store.findings.delete_rows", "3"),
        answered("data_store.findings.select", "4"),
        answered("data_store.findings.insert", "5", "output_error"),
        answered("knowledge.add_files", "6")
      ])
    ).toEqual(["1", "2", "3"]);
  });
});
