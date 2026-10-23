// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslationContext, TranslationProvider } from "./support/chat-ui/shared";
import {
  StepPanel,
  StepSettings,
  StepSettingsBar,
  WorkflowsHostProvider,
  WorkflowsSourceProvider,
  mailAnswerOf,
  mailFooter,
  newStepOf,
  mailRunOf,
  readCutJson,
  recipientsInput,
  sampleMarkdown,
  textInput,
  textParts,
  toWorkflow,
  toWorkflowRun,
  toWorkflowStepRun,
  useWorkflow,
  useWorkflowEditing,
  workflowGraph,
  type WorkflowsHost,
  type WorkflowsSource
} from "@work-shape/catalyst-chat-ui/workflows";
import { WorkspaceApiClientProvider } from "@work-shape/catalyst-chat-ui/workspace-api-client";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { renderToStaticMarkup } from "./chat-ui-render-harness";
import { CONDITION_WAIT_MS, required } from "./support/assertions";

// MAIL-3 (workflow-canvas 3, 9.2, 9.3, 9.4; Events checks 141 and 142): a step on `mail.send`
// reads "Sends an e-mail" with the sender's icon and name and never the transport's; its panel
// shows the mail in the instance's frame, and "This run" the mail as sent only to a reader given
// the step run's input. Its Settings write `to`, `subject` and `body` in the forms `mail.send`
// takes, the subject and text in the `text` form where a value of a step stands in them, and
// mark an address outside the instance's domains before Save.

const en = createTranslationContext("en");
const { t } = en;
const noop = () => undefined;
const WORKFLOW = "monthly-check";

type Config = Readonly<Record<string, unknown>>;
type StepRunResource = Parameters<typeof toWorkflowStepRun>[0];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const MAIL_FACT = {
  effect: "changing" as const,
  available: true,
  source: { kind: "mail_sender" as const, title: "Example office", service: "system-mail" },
  mailSender: {
    sender: "system",
    title: "Example office",
    icon: "system-mail",
    address: "office@example.test",
    recipientDomains: ["example.test"]
  }
};
const LOAD_FACT = {
  effect: "reading" as const,
  available: true,
  source: { kind: "connection" as const, title: "Bookings" },
  outputSchema: {
    type: "object",
    properties: {
      emails: { type: "array", title: "Client addresses", items: { type: "string" } },
      findings: { type: "array", title: "Findings", items: { type: "object" } }
    }
  }
};
const stepFacts = { send: MAIL_FACT, load: LOAD_FACT };

const sendStep = {
  id: "send",
  name: "Send the result",
  type: "operation",
  operation: "mail.send",
  input: {
    sender: { value: "system" },
    to: {
      value: [{ user: "usr_mara" }, { workspace: "ws_finance" }, { address: "anna@example.test" }]
    },
    cc: { ref: { step: "load", path: "emails" } },
    subject: { text: ["Check result ", { ref: { step: "start", path: "input.month" } }] },
    body: { text: ["Good morning,\n\n", { ref: { step: "load", path: "findings" } }] }
  }
};
const manifest = {
  id: WORKFLOW,
  name: "Monthly check",
  inputs: { type: "object", properties: { month: { type: "string", title: "Month" } } },
  steps: [
    { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
    {
      id: "load",
      name: "Load the bookings",
      type: "operation",
      operation: "connection.crm.load",
      input: {}
    },
    sendStep,
    { id: "result", name: "Result", type: "output", input: { done: { value: 1 } } }
  ]
};

const names = {
  people: new Map([["usr_mara", "Mara Lindqvist"]]),
  workspaces: new Map([["ws_finance", "Team Finance"]])
};
const host: WorkflowsHost = {
  rights: { instance: { read: true, write: true, publish: false, delete: false } },
  viewerId: "usr_mara",
  workspace: { id: "ws_finance", name: "Team Finance" },
  showRoute: noop,
  recipients: names,
  brand: { name: "Example office" }
};

const workflow = toWorkflow(
  { name: WORKFLOW, config: manifest, publishedRevision: 1 },
  {},
  { stepFacts }
);
const step = required(workflow.steps.find((entry) => entry.id === "send"));

function stepRun(input: Partial<StepRunResource>): StepRunResource {
  return {
    id: "sr_send",
    stepId: "send",
    stepType: "operation",
    status: "done",
    attempt: 1,
    createdAt: "2026-10-12T07:41:59.000Z",
    startedAt: "2026-10-12T07:42:00.000Z",
    finishedAt: "2026-10-12T07:42:01.000Z",
    ...input
  };
}
const SENT_INPUT = JSON.stringify({
  sender: "system",
  to: [{ user: "usr_mara" }, { address: "anna@example.test" }],
  cc: ["otto@example.test"],
  subject: "Check result September",
  body: "Good morning,\n\n- Invoice 114 has no receipt"
});
const SENT = {
  sentAt: "2026-10-12T07:42:01.000Z",
  recipients: { to: 2, cc: 1, bcc: 0 },
  skipped: 0
};
const SENT_OUTPUT = JSON.stringify(SENT);
const TEST_OUTPUT = JSON.stringify({ ...SENT, test: true });

function panel(tab: "what" | "run", run?: StepRunResource, draft = false): string {
  const graph = workflowGraph(workflow.steps, en, undefined, names);
  const part = required(graph.nodes.find((node) => node.id === "send"));
  const node: ReactNode = createElement(WorkflowsHostProvider, {
    value: host,
    children: createElement(StepPanel, {
      step,
      part,
      run:
        run === undefined
          ? undefined
          : { stepRun: toWorkflowStepRun(run), counts: undefined, now: new Date() },
      tab,
      onTabChange: noop,
      entries: null,
      onClose: noop,
      ...(draft ? { settings: { content: null, footer: null, editing: false } } : {})
    })
  });
  return renderToStaticMarkup(createElement(TranslationProvider, { locale: "en", children: node }));
}

describe("a Send email step on the canvas (MAIL-3a, check 141)", () => {
  it("reads as sending an e-mail, as the sender, to its first recipient and how many more", () => {
    const graph = workflowGraph(workflow.steps, en, undefined, names);
    const node = required(graph.nodes.find((entry) => entry.id === "send"));
    expect(node.eyebrow).toBe(t("workflows.mail.eyebrow"));
    expect(node.icon).toBe("system-mail");
    expect(node.iconFallback).toBe("mail");
    expect(node.chip).toEqual({
      label: "Example office",
      icon: "system-mail",
      iconFallback: "mail"
    });
    expect(node.summary).toBe("To Mara Lindqvist and 3 more · Check result [Month]");
    expect(JSON.stringify(graph)).not.toMatch(/mailjet/iu);
  });

  it("says when it sent, as a test, or that a test run simulated it", () => {
    const at = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }).format(
      new Date("2026-10-12T07:42:01.000Z")
    );
    const sent = toWorkflowStepRun(
      stepRun({ outputPreview: { text: SENT_OUTPUT, truncated: false } })
    );
    expect(mailFooter(sent, en)).toBe(t("workflows.mail.sentToAt", { count: "3", time: at }));
    const test = toWorkflowStepRun(
      stepRun({
        target: "test",
        outputPreview: { text: TEST_OUTPUT, truncated: false }
      })
    );
    expect(mailFooter(test, en)).toBe(t("workflows.mail.sentTestAt", { time: at }));
    const simulated = toWorkflowStepRun(stepRun({ target: "dry_run" }));
    expect(mailFooter(simulated, en)).toBe(t("workflows.mail.simulated"));
    const graph = workflowGraph(workflow.steps, en, {
      run: toWorkflowRun({
        id: "wr_1",
        workflow: WORKFLOW,
        trigger: "manual",
        status: "done",
        startedBy: { id: "usr_mara", label: "Mara Lindqvist" },
        createdAt: "2026-10-12T07:41:00.000Z"
      }),
      stepRuns: [sent],
      now: new Date("2026-10-12T08:00:00.000Z")
    });
    expect(graph.nodes.find((node) => node.id === "send")?.footer).toBe(
      t("workflows.mail.sentToAt", { count: "3", time: at })
    );
  });
});

describe("the panel of a Send email step (MAIL-3a, check 141)", () => {
  it("names the sender, the recipients, the subject and the text, and where it may send", () => {
    const html = panel("what");
    expect(html).toContain(
      t("workflows.mail.sentence", {
        subject: "Check result [Month]",
        to: "Mara Lindqvist, Team Finance, anna@example.test, and Client addresses from “Load the bookings”",
        sender: "Example office"
      })
    );
    expect(html).toContain(
      'title="office@example.test" data-mail-from-address="">office@example.test<'
    );
    expect(html).toContain('data-mail-recipient="picked"');
    expect(html).toContain('data-template-option="load#findings"');
    expect(html).toContain(t("workflows.mail.maySendTo", { domains: "example.test" }));
    expect(html).toContain('data-mail-brand=""');
    expect(html).not.toContain(t("workflows.mail.draftNote"));
    expect(html).not.toMatch(/mailjet/iu);
    expect(panel("what", undefined, true)).toContain(t("workflows.mail.draftNote"));
  });

  it("shows the mail as sent to a reader given the step run's input", () => {
    const html = panel(
      "run",
      stepRun({
        inputPreview: { text: SENT_INPUT, truncated: false },
        outputPreview: { text: SENT_OUTPUT, truncated: false }
      })
    );
    expect(html).toContain('data-mail-preview="rendered"');
    expect(html).toContain("Check result September");
    expect(html).toContain("Invoice 114 has no receipt");
    expect(html).toContain("Mara Lindqvist");
    expect(html).toContain("otto@example.test");
  });

  it("shows no body to a reader not given the input", () => {
    const html = panel("run", stepRun({ outputPreview: { text: SENT_OUTPUT, truncated: false } }));
    expect(html).toContain('data-mail-no-content=""');
    expect(html).not.toContain("data-mail-preview");
    expect(html).not.toContain("Invoice 114");
  });

  it("marks a simulated mail and a test send", () => {
    const simulated = panel(
      "run",
      stepRun({
        target: "dry_run",
        inputPreview: { text: SENT_INPUT, truncated: false },
        outputPreview: {
          text: JSON.stringify({
            simulated: true,
            preview: {
              from: { name: "Example office", address: "office@example.test" },
              to: [{ kind: "person", label: "Mara Lindqvist" }],
              cc: [],
              bcc: [],
              skipped: 0,
              subject: "Check result September",
              html: "<p>cut",
              text: "Good morning"
            }
          }).slice(0, 300),
          truncated: true
        }
      })
    );
    expect(simulated).toContain('data-mail-preview="simulated"');
    // A rendered body cut by the preview's bound is not drawn; the input's text is.
    expect(simulated).not.toContain("<iframe");
    expect(simulated).toContain("Invoice 114 has no receipt");
    const test = panel(
      "run",
      stepRun({
        target: "test",
        inputPreview: { text: SENT_INPUT, truncated: false },
        outputPreview: { text: TEST_OUTPUT, truncated: false }
      })
    );
    expect(test).toContain('data-mail-preview="test"');
    expect(test).toContain("[Test]");
  });

  it("keeps the mail beside the failure of a refused send", () => {
    const html = panel(
      "run",
      stepRun({
        status: "failed",
        inputPreview: { text: SENT_INPUT, truncated: false },
        error: {
          code: "VALIDATION_FAILED",
          message: "The mail was refused"
        }
      })
    );
    expect(html).toContain('data-mail-preview="rendered"');
    expect(html).not.toContain(t("workflows.mail.sentTo", { count: "3" }));
  });
});

describe("the values of a mail step run", () => {
  it("reads a cut input as far as it goes", () => {
    const cut = SENT_INPUT.slice(0, SENT_INPUT.indexOf("Good morning") + 6);
    expect(readCutJson(cut)).toMatchObject({ subject: "Check result September", body: "Good m" });
    expect(mailRunOf({ text: cut, truncated: true })).toMatchObject({
      to: [
        { kind: "user", id: "usr_mara" },
        { kind: "address", address: "anna@example.test" }
      ],
      cc: [{ kind: "address", address: "otto@example.test" }],
      shortened: true
    });
  });

  it("reads a sent and a simulated answer", () => {
    expect(mailAnswerOf({ text: SENT_OUTPUT, truncated: false })).toEqual({
      kind: "sent",
      sentAt: "2026-10-12T07:42:01.000Z",
      count: 3,
      test: false,
      skipped: 0
    });
    expect(mailAnswerOf({ text: '{"simulated":true}', truncated: false })).toEqual({
      kind: "simulated"
    });
  });
});

describe("the forms Settings write (MAIL-3b, check 142)", () => {
  it("adds a new mail from the palette as the instance's own sender", () => {
    const added = required(
      newStepOf(
        "operation:mail.send",
        [
          {
            name: "mail.send",
            title: "Send mail",
            effect: "changing",
            source: { kind: "other", title: "Example office" },
            available: true
          }
        ],
        t
      )
    );
    expect(added.name).toBe(t("workflows.palette.mail"));
    expect(added.fields("send_mail")).toMatchObject({
      type: "operation",
      operation: "mail.send",
      input: { sender: { value: "system" } }
    });
  });

  it("writes recipients as a list or as the one field of a step", () => {
    expect(
      recipientsInput([
        { kind: "person", value: "usr_mara", label: "Mara" },
        { kind: "workspace", value: "ws_finance", label: "Finance" },
        { kind: "address", value: "anna@example.test", label: "anna@example.test" }
      ])
    ).toEqual({
      value: [{ user: "usr_mara" }, { workspace: "ws_finance" }, { address: "anna@example.test" }]
    });
    expect(recipientsInput([{ kind: "picked", value: "load#emails", label: "Addresses" }])).toEqual(
      {
        ref: { step: "load", path: "emails" }
      }
    );
    expect(recipientsInput([])).toBeUndefined();
  });

  it("round-trips a text with chips through the text form", () => {
    const parts = [
      "Check result ",
      { option: "start#input.month" },
      " for ",
      { option: "load#client" }
    ];
    const saved = textInput(parts);
    expect(saved).toEqual({
      text: [
        "Check result ",
        { ref: { step: "start", path: "input.month" } },
        " for ",
        { ref: { step: "load", path: "client" } }
      ]
    });
    const resolve = () => ({ from: { from: "run_input" as const }, field: "x" });
    expect(textParts(saved, resolve)).toEqual(parts);
    expect(textInput(["Hello"])).toEqual({ value: "Hello" });
    expect(textParts({ value: "Hello" }, resolve)).toEqual(["Hello"]);
    expect(textInput([])).toBeUndefined();
  });

  it("joins a sample list as Markdown the way the run joins it", () => {
    expect(sampleMarkdown(["a", "b"])).toBe("\n- a\n- b\n");
    expect(sampleMarkdown([{ invoice: "114", note: "no receipt" }])).toBe(
      "\n| invoice | note |\n| --- | --- |\n| 114 | no receipt |\n"
    );
  });
});

// --- Settings in the DOM -------------------------------------------------------------------

function sourceOf(saves: Config[]): WorkflowsSource {
  let draft = { config: { name: WORKFLOW, manifest } as Config, revision: 2 };
  const view = () => {
    const current = isRecord(draft.config.manifest) ? draft.config.manifest : {};
    return {
      ...toWorkflow(
        { name: WORKFLOW, config: current, publishedRevision: 2 },
        {},
        { draftRevision: draft.revision, publishedRevision: 2, stepFacts }
      ),
      definition: { config: draft.config, manifest: current, revision: draft.revision, stepFacts }
    };
  };
  const unused = () => Promise.reject(new Error("Not read by Settings."));
  return {
    key: "step-settings-mail",
    listWorkflows: unused,
    getWorkflow: () => Promise.resolve(view()),
    runs: undefined,
    stepChoices: {
      listOperations: () => Promise.resolve({ items: [], nextCursor: undefined }),
      listChildWorkflows: () => Promise.resolve({ items: [], nextCursor: undefined })
    },
    drafts: {
      publish: unused,
      discard: unused,
      test: unused,
      runLiveOnce: unused,
      listLiveOnce: unused,
      readRevision: () => Promise.resolve(required(view().definition)),
      validate: () => Promise.resolve([]),
      save: (_workflow, config, expected) => {
        saves.push(config);
        draft = { config, revision: expected + 1 };
        return Promise.resolve({ revision: expected + 1 });
      }
    }
  };
}

function Harness() {
  const read = useWorkflow("cw_1", WORKFLOW);
  const editing = useWorkflowEditing({
    workspaceId: "cw_1",
    workflowId: WORKFLOW,
    workflow: read.workflow,
    mayWrite: true
  });
  if (editing === undefined) return null;
  return createElement(
    "div",
    null,
    createElement(StepSettings, { stepId: "send", editing, edit: undefined }),
    createElement(StepSettingsBar, { stepId: "send", editing })
  );
}

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
});

async function mount(source: WorkflowsSource): Promise<HTMLElement> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          WorkspaceApiClientProvider,
          { apiBaseUrl: "https://chat.example.com", children: null },
          createElement(
            WorkflowsSourceProvider,
            { source, children: null },
            createElement(
              WorkflowsHostProvider,
              { value: host, children: null },
              createElement(
                TranslationProvider,
                { locale: "en", children: null },
                createElement(UiRoot, { mode: "light", labels: uiLabelsEn }, createElement(Harness))
              )
            )
          )
        )
      )
    );
  });
  unmounts.push(async () => {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
    vi.unstubAllGlobals();
  });
  return container;
}

async function settled(check: () => void) {
  await vi.waitFor(async () => act(async () => check()), { timeout: CONDITION_WAIT_MS });
}

describe("the Settings of a Send email step in the DOM (MAIL-3b, check 142)", () => {
  it("shows the step's mail, marks an address outside the domains, and saves the text form", async () => {
    const saves: Config[] = [];
    const container = await mount(sourceOf(saves));
    const to = () => required(container.querySelector('[data-mail-field="to"]'));
    await settled(() => expect(to().textContent).toContain("Mara Lindqvist"));
    expect(
      container.querySelector('[data-mail-field="cc"] [data-recipient="picked"]')?.textContent
    ).toContain("Client addresses");
    const subject = required(
      container.querySelector<HTMLElement>('[data-mail-field="subject"] [data-template-editor]')
    );
    expect(subject.querySelector('[data-template-option="start#input.month"]')?.textContent).toBe(
      "Month"
    );

    // A typed address outside example.test is marked before Save.
    const typing = required(to().querySelector<HTMLInputElement>("input"));
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        typing,
        "otto@outside.test"
      );
      typing.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      typing.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settled(() =>
      expect(to().querySelector("[data-recipient-invalid]")?.textContent).toContain(
        t("workflows.mail.outsideAddress", { domain: "outside.test" })
      )
    );

    // The subject is changed in place and saved in the text form with its chip.
    await act(async () => {
      subject.append(document.createTextNode(" now"));
      subject.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = () =>
      required(
        [...container.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent === t("workflows.settings.save")
        )
      );
    await settled(() => expect(save().disabled).toBe(false));
    await act(async () => save().click());
    await settled(() => expect(saves).toHaveLength(1));
    const saved = isRecord(saves[0]?.manifest) ? saves[0].manifest : {};
    const sent = (Array.isArray(saved.steps) ? saved.steps : []).find(
      (entry) => isRecord(entry) && entry.id === "send"
    );
    expect(isRecord(sent) ? sent.input : undefined).toMatchObject({
      to: {
        value: [
          { user: "usr_mara" },
          { workspace: "ws_finance" },
          { address: "anna@example.test" },
          { address: "otto@outside.test" }
        ]
      },
      cc: { ref: { step: "load", path: "emails" } },
      subject: { text: ["Check result ", { ref: { step: "start", path: "input.month" } }, " now"] },
      body: sendStep.input.body
    });
  });
});
