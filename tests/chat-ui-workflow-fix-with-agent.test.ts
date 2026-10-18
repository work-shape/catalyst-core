// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@work-shape/catalyst-api-client";
import { createTranslationContext, TranslationProvider } from "@work-shape/catalyst-chat-ui";
import {
  fixWithAgentPrompt,
  toWorkflow,
  toWorkflowRun,
  toWorkflowStepRun,
  WorkflowRunPage,
  WorkflowsHostProvider,
  WorkflowsSourceProvider,
  type WorkflowsHost,
  type WorkflowsSource
} from "@work-shape/catalyst-chat-ui/workflows";
import { WorkspaceApiClientProvider } from "@work-shape/catalyst-chat-ui/workspace-api-client";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { CONDITION_WAIT_MS, required } from "./support/assertions";
import { openConversationAbout } from "./support/chat-ui";

// A failed run's "Fix with the agent" (UXA-6b): the main button of a failed run's page for a
// reader who may write the Workflow, "Run again" beside it for whoever may start it, and the
// conversation it starts: about the Workflow, beside the Workflow's page, with the failed step
// and its reason in the composer. Every test here fails without the button, the prompt or the
// way the prompt reaches the composer.

const en = createTranslationContext("en");
const german = createTranslationContext("de");
const { t } = en;

type RunResource = Parameters<typeof toWorkflowRun>[0];
type StepRunResource = Parameters<typeof toWorkflowStepRun>[0];

const definition = {
  id: "notify-clients",
  name: "Notify clients",
  steps: [
    { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
    { id: "clients", name: "Load the clients", type: "operation", operation: "crm.list" },
    {
      id: "each_client",
      name: "For each client",
      type: "loop",
      items: { step: "clients", path: "" },
      steps: [{ id: "send", name: "Send the note", type: "operation", operation: "crm.write" }]
    },
    { id: "result", name: "Result", type: "output", input: {} }
  ]
};
/** The Workflow as a reader who may write it is answered: with its draft. */
const workflowFor = ({ mayStart }: { mayStart: boolean }) =>
  toWorkflow(
    { name: "notify-clients", config: definition, publishedRevision: 2 },
    { mayStart },
    { draftRevision: 2, publishedRevision: 2 }
  );

const createdAt = "2026-10-12T09:00:00.000Z";
const failedRun = (input: Partial<RunResource> = {}): RunResource => ({
  id: "wr_1",
  workflow: "notify-clients",
  trigger: "manual",
  status: "failed",
  startedBy: { id: "user_1", label: "Ada Lovelace" },
  createdAt,
  startedAt: "2026-10-12T09:00:01.000Z",
  finishedAt: "2026-10-12T09:00:42.000Z",
  error: { code: "FORBIDDEN", message: "The instance's own sentence" },
  ...input
});
const stepRun = (
  input: Partial<StepRunResource> & Pick<StepRunResource, "id" | "stepId">
): StepRunResource => ({
  stepType: "operation",
  status: "done",
  attempt: 1,
  createdAt,
  ...input
});
const failedClients = stepRun({
  id: "sr_clients",
  stepId: "clients",
  status: "failed",
  error: { code: "FORBIDDEN", message: "The instance's own sentence" }
});

const unused = () => Promise.reject(new Error("Not read by the page of a run."));

/** A source that answers the run, its Workflow and, once `stepRuns` settles, its step runs. */
function sourceOf(
  run: RunResource,
  stepRuns: Promise<readonly StepRunResource[]>,
  mayStart: boolean
): WorkflowsSource {
  return {
    key: "fix-with-agent",
    listWorkflows: unused,
    getWorkflow: () => Promise.resolve(workflowFor({ mayStart })),
    runs: {
      listRuns: unused,
      getRun: () => Promise.resolve(toWorkflowRun(run)),
      listFrameStepRuns: async () => ({
        stepRuns: (await stepRuns).map(toWorkflowStepRun),
        entryLoops: [],
        nextCursor: undefined
      }),
      listEntryStepRuns: unused,
      start: unused,
      cancel: unused
    }
  };
}

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) {
    await unmount();
  }
});

/** Mounts the real page of a run for a reader with these rights. */
async function mountRunPage({
  run = failedRun(),
  stepRuns = Promise.resolve([failedClients]),
  write = true,
  mayStart = true,
  editWithAgent = vi.fn<NonNullable<WorkflowsHost["editWithAgent"]>>(() => Promise.resolve())
}: {
  run?: RunResource;
  stepRuns?: Promise<readonly StepRunResource[]>;
  write?: boolean;
  mayStart?: boolean;
  editWithAgent?: NonNullable<WorkflowsHost["editWithAgent"]>;
} = {}): Promise<HTMLElement> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const host: WorkflowsHost = {
    rights: { instance: { read: true, write, publish: false, delete: false } },
    viewerId: "user_1",
    workspace: { id: "cw_1", name: "Office" },
    showRoute: () => undefined,
    editWithAgent
  };
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
            { source: sourceOf(run, stepRuns, mayStart), children: null },
            createElement(
              WorkflowsHostProvider,
              { value: host, children: null },
              createElement(
                TranslationProvider,
                { locale: "en", children: null },
                createElement(
                  UiRoot,
                  { mode: "light", labels: uiLabelsEn },
                  createElement(WorkflowRunPage, { workflow: "notify-clients", run: "wr_1" })
                )
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

function buttonNamed(container: ParentNode, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === label
  );
}

/** Waits until the page drew its head with the run's state. */
async function waitForHead(container: HTMLElement): Promise<void> {
  await vi.waitFor(
    async () => {
      await act(async () => {
        expect(container.textContent).toContain(t("workflows.run.failed"));
        expect(container.textContent).toContain("Notify clients");
      });
    },
    { timeout: CONDITION_WAIT_MS }
  );
}

/** The run's moment as its page's title says it. */
const runDate = new Date(createdAt).toLocaleString("en", { dateStyle: "long", timeStyle: "short" });
const atClients = t("workflows.fix.promptAtStep", {
  date: runDate,
  step: "Load the clients",
  reason: t("workflows.reason.missingRight")
});

describe("the main button of a failed run's page", () => {
  it("is Fix with the agent for a writer, with Run again as the secondary action", async () => {
    const container = await mountRunPage();
    await waitForHead(container);
    const fix = required(buttonNamed(container, t("workflows.fix.withAgent")));
    const again = required(buttonNamed(container, t("workflows.run.again")));
    const buttons = [...container.querySelectorAll("button")];
    // The secondary actions stand before the primary one, and look unlike it.
    expect(buttons.indexOf(again)).toBeLessThan(buttons.indexOf(fix));
    expect(again.className).not.toBe(fix.className);
  });

  it("opens the conversation about the Workflow with the failed step and its reason", async () => {
    const editWithAgent = vi.fn<NonNullable<WorkflowsHost["editWithAgent"]>>(() =>
      Promise.resolve()
    );
    const container = await mountRunPage({ editWithAgent });
    await waitForHead(container);
    const fix = required(buttonNamed(container, t("workflows.fix.withAgent")));
    await vi.waitFor(() => expect(fix.disabled).toBe(false), { timeout: CONDITION_WAIT_MS });
    await act(async () => fix.click());
    expect(editWithAgent).toHaveBeenCalledTimes(1);
    const [workflow, prompt] = required(editWithAgent.mock.calls[0]);
    expect(workflow).toBe("notify-clients");
    expect(prompt).toBe(atClients);
    expect(prompt).not.toContain("FORBIDDEN");
    expect(prompt).not.toContain("The instance's own sentence");
  });

  it("waits for the step runs, so a click never loses the failed step", async () => {
    let arrive: (stepRuns: readonly StepRunResource[]) => void = () => undefined;
    const stepRuns = new Promise<readonly StepRunResource[]>((resolve) => {
      arrive = resolve;
    });
    const container = await mountRunPage({ stepRuns });
    await waitForHead(container);
    expect(required(buttonNamed(container, t("workflows.fix.withAgent"))).disabled).toBe(true);
    await act(async () => arrive([failedClients]));
    await vi.waitFor(
      () =>
        expect(required(buttonNamed(container, t("workflows.fix.withAgent"))).disabled).toBe(false),
      { timeout: CONDITION_WAIT_MS }
    );
  });

  it("offers no Run again beside it to a writer who may not start the Workflow", async () => {
    const container = await mountRunPage({ mayStart: false });
    await waitForHead(container);
    expect(buttonNamed(container, t("workflows.fix.withAgent"))).toBeDefined();
    expect(buttonNamed(container, t("workflows.run.again"))).toBeUndefined();
  });

  it("stays Run again for a reader who may not write the Workflow", async () => {
    const container = await mountRunPage({ write: false });
    await waitForHead(container);
    expect(buttonNamed(container, t("workflows.fix.withAgent"))).toBeUndefined();
    expect(buttonNamed(container, t("workflows.run.again"))).toBeDefined();
  });

  it("is not offered for a run that did not fail", async () => {
    const container = await mountRunPage({ run: failedRun({ status: "done", error: undefined }) });
    await vi.waitFor(
      async () => {
        await act(async () => {
          expect(container.textContent).toContain(t("workflows.run.done"));
        });
      },
      { timeout: CONDITION_WAIT_MS }
    );
    expect(buttonNamed(container, t("workflows.fix.withAgent"))).toBeUndefined();
    expect(buttonNamed(container, t("workflows.run.again"))).toBeDefined();
  });

  it("says on the page where the instance refuses the conversation", async () => {
    const container = await mountRunPage({
      editWithAgent: () =>
        Promise.reject(
          new ApiError(403, "Forbidden", { error: { code: "FORBIDDEN", message: "x" } })
        )
    });
    await waitForHead(container);
    const fix = required(buttonNamed(container, t("workflows.fix.withAgent")));
    await vi.waitFor(() => expect(fix.disabled).toBe(false), { timeout: CONDITION_WAIT_MS });
    await act(async () => fix.click());
    await vi.waitFor(
      async () => {
        await act(async () => {
          expect(container.textContent).toContain(t("workflows.edit.refused"));
        });
      },
      { timeout: CONDITION_WAIT_MS }
    );
  });
});

describe("what Fix with the agent puts into the composer", () => {
  const steps = workflowFor({ mayStart: true }).steps;
  const run = toWorkflowRun(failedRun());

  it("names a step inside a loop by its name", () => {
    const send = toWorkflowStepRun(
      stepRun({
        id: "sr_send",
        stepId: "send",
        status: "failed",
        error: { code: "x", message: "y" }
      })
    );
    expect(fixWithAgentPrompt(run, [send], steps, en)).toContain("“Send the note”");
  });

  it("names no step the drawn steps do not hold, and never its id", () => {
    const gone = toWorkflowStepRun(
      stepRun({
        id: "sr_old",
        stepId: "old_step",
        status: "failed",
        error: { code: "x", message: "y" }
      })
    );
    const prompt = fixWithAgentPrompt(run, [gone], steps, en);
    expect(prompt).not.toContain("old_step");
    expect(prompt).toContain(t("workflows.reason.other"));
    expect(prompt).toBe(
      t("workflows.fix.prompt", {
        date: runDate,
        reason: t("workflows.reason.other")
      })
    );
  });

  it("says the run's reason where no step failed, and the general one where none arrived", () => {
    expect(fixWithAgentPrompt(run, [], steps, en)).toContain(t("workflows.reason.missingRight"));
    const unexplained = toWorkflowRun(failedRun({ error: undefined }));
    expect(fixWithAgentPrompt(unexplained, [], undefined, en)).toContain(
      t("workflows.reason.other")
    );
  });

  it("speaks German with du", () => {
    const prompt = fixWithAgentPrompt(run, [toWorkflowStepRun(failedClients)], steps, german);
    expect(prompt).toContain("„Load the clients“");
    expect(prompt).toContain(german.t("workflows.reason.missingRight"));
    expect(prompt).toContain("Finde die Ursache");
  });
});

describe("the conversation the instance made about the Workflow", () => {
  it("opens beside the Workflow's page with the prompt in its composer", () => {
    const openPage = vi.fn();
    const showConversation = vi.fn();
    const setDraft = vi.fn();
    openConversationAbout(
      { id: "conv_1", collaborationWorkspaceId: "cw_1" },
      { kind: "workflow", name: "notify-clients" },
      atClients,
      { routeState: { showConversation }, dock: { openPage }, draftController: { setDraft } }
    );
    expect(openPage).toHaveBeenCalledWith(
      { kind: "workflow", collaborationWorkspaceId: "cw_1", workflow: "notify-clients" },
      "conv_1"
    );
    expect(showConversation).not.toHaveBeenCalled();
    expect(setDraft).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv_1" }),
      atClients
    );
  });

  it("leaves the composer as it is where no prompt is given", () => {
    const setDraft = vi.fn();
    openConversationAbout(
      { id: "conv_1", collaborationWorkspaceId: "cw_1" },
      { kind: "workflow", name: "notify-clients" },
      undefined,
      {
        routeState: { showConversation: vi.fn() },
        dock: { openPage: vi.fn() },
        draftController: { setDraft }
      }
    );
    expect(setDraft).not.toHaveBeenCalled();
  });
});
