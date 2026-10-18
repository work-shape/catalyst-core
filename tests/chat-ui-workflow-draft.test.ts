import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";
import {
  DraftChangeDialog,
  WorkflowPageView,
  createInstanceSource,
  draftState,
  editOffered,
  toWorkflow
} from "@work-shape/catalyst-chat-ui/workflows";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { recordedApiClient } from "./support/recorded-api-client";

// The draft of a Workflow on its page: who is offered the conversation in which the agent
// changes it, and what the bar says of a draft that is not the published revision. Every test
// here fails without the page half of "the agent edits a Workflow": the page named no draft,
// offered no conversation and neither published nor discarded.

const { t } = createTranslationContext("en");
const de = createTranslationContext("de").t;
const render = (node: ReactNode, locale: "en" | "de" = "en") =>
  renderToStaticMarkup(createElement(TranslationProvider, { locale, children: node }));
const noop = () => undefined;
const { signal } = new AbortController();

const definition = {
  id: "month-end",
  name: "Month end",
  steps: [
    { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
    { id: "result", name: "Result", type: "output", input: {} }
  ]
};

/** A Workflow as its page holds it, with the pointers the instance named of its asset. */
const workflowAt = (pointers: { draftRevision?: number; publishedRevision?: number }) =>
  toWorkflow(
    { name: "month-end", config: definition, publishedRevision: pointers.publishedRevision },
    { mayStart: true },
    pointers
  );

const ahead = workflowAt({ draftRevision: 6, publishedRevision: 4 });
const level = workflowAt({ draftRevision: 4, publishedRevision: 4 });
const unpublished = workflowAt({ draftRevision: 1 });
/** What a reader without the write and the publish right is answered: no draft is named. */
const publishedView = workflowAt({ publishedRevision: 4 });

describe("how the draft of a Workflow stands beside what is published", () => {
  it("says that the draft differs where it is another revision than the published one", () => {
    expect(ahead.draft).toEqual({
      revision: 6,
      publishedRevision: 4,
      testForm: { fields: [], unsupported: [] }
    });
    expect(draftState(ahead)).toBe("ahead");
  });

  it("says nothing where the draft is the published revision", () => {
    expect(draftState(level)).toBeUndefined();
  });

  it("says of a draft that was never published that it is not published, not that it differs", () => {
    expect(unpublished.draft).toEqual({ revision: 1, testForm: { fields: [], unsupported: [] } });
    expect(draftState(unpublished)).toBe("unpublished");
  });

  it("says nothing to a reader the instance answers the published revision", () => {
    expect(publishedView.draft).toBeUndefined();
    expect(draftState(publishedView)).toBeUndefined();
    expect(draftState(undefined)).toBeUndefined();
  });
});

describe("who is offered to edit a Workflow with the agent", () => {
  const writes = (write: boolean) => ({
    instance: { read: true, write, publish: false, delete: false }
  });

  it("offers it to a reader who may write Workflows and is shown the draft", () => {
    expect(editOffered(writes(true), ahead)).toBe(true);
    expect(editOffered(writes(true), level)).toBe(true);
    expect(editOffered(writes(true), unpublished)).toBe(true);
  });

  it("offers it to nobody without the right to write Workflows", () => {
    expect(editOffered(writes(false), ahead)).toBe(false);
  });

  it("offers it nowhere the instance named no draft, and not before the record arrived", () => {
    expect(editOffered(writes(true), publishedView)).toBe(false);
    expect(editOffered(writes(true), undefined)).toBe(false);
  });
});

describe("the draft of a Workflow over an instance", () => {
  const asset = {
    id: "asset_1",
    kind: "workflow",
    name: "month-end",
    scope: { kind: "instance" },
    revision: 6,
    draftRevision: 6,
    publishedRevision: 4,
    updatedAt: "2026-10-10T09:00:00.000Z",
    config: { name: "month-end", manifest: definition }
  };
  const instance = (answer: Record<string, unknown> = asset) => {
    const { client, calls } = recordedApiClient(({ operation }) => {
      switch (operation) {
        case "assets.get":
          return answer;
        case "workflows.list":
          return {
            items: [
              {
                id: "month-end",
                name: "Month end",
                definitionRevisionId: "rev_4",
                actions: ["workflow.read", "workflow.use"],
                runnable: true,
                reasons: []
              }
            ]
          };
        default:
          return { draftRevision: 6, publishedRevision: 6 };
      }
    });
    return { source: createInstanceSource(client, "k"), calls };
  };

  it("reads the two pointers of the draft from the read of the asset", async () => {
    const { source } = instance();
    const workflow = await source.getWorkflow("cw_1", "month-end", signal);
    expect(workflow.draft).toEqual({
      revision: 6,
      publishedRevision: 4,
      testForm: { fields: [], unsupported: [] }
    });
    expect(draftState(workflow)).toBe("ahead");
  });

  it("carries the limits the draft raises from the read of the asset to the publish question", async () => {
    const raise = "Raises the run time of each run from 12h to 30h.";
    const { source } = instance({ ...asset, publishQuestion: [raise] });
    const workflow = await source.getWorkflow("cw_1", "month-end", signal);
    expect(workflow.draft?.publishQuestion).toEqual([raise]);
  });

  it("names no draft where the instance answered the published view", async () => {
    const { draftRevision: _left, ...publishedAnswer } = { ...asset, revision: 4 };
    const { source } = instance(publishedAnswer);
    const workflow = await source.getWorkflow("cw_1", "month-end", signal);
    expect(workflow.draft).toBeUndefined();
    expect(workflow.published).toBe(true);
  });

  it("publishes the revision the page read, by its number", async () => {
    const { source, calls } = instance();
    await source.drafts?.publish("month-end", 6);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      operation: "assets.publish",
      params: { kind: "workflow", name: "month-end" }
    });
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ revision: 6 });
  });

  it("discards the draft it read, named as the revision it expects", async () => {
    const { source, calls } = instance();
    await source.drafts?.discard("month-end", 6);
    expect(calls[0]).toMatchObject({
      operation: "assets.discard_draft",
      params: { kind: "workflow", name: "month-end" }
    });
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ expectedRevision: 6 });
  });
});

describe("the page of a Workflow with a draft", () => {
  const edit: {
    busy: boolean;
    error: string | undefined;
    start(): void;
    startWith(prompt: string): void;
    dismissError(): void;
  } = {
    busy: false,
    error: undefined,
    start: noop,
    startWith: noop,
    dismissError: noop
  };
  const page = (
    input: {
      workflow?: typeof ahead;
      edit?: Partial<typeof edit>;
      offered?: boolean;
      draft?: { state: "ahead" | "unpublished"; onPublish?: () => void; onDiscard?: () => void };
    } = {},
    locale: "en" | "de" = "en"
  ) =>
    render(
      createElement(WorkflowPageView, {
        workspaceId: "cw_1",
        workflowId: "month-end",
        read: { workflow: input.workflow ?? ahead, problem: undefined, retry: noop },
        runsAvailable: true,
        edit: input.offered === false ? undefined : { ...edit, ...input.edit },
        draft: input.draft,
        onOpenChild: noop,
        onOpenRoute: noop,
        onStart: noop
      }),
      locale
    );

  it("offers the conversation with the agent beside the start, in both languages", () => {
    const markup = page();
    expect(markup).toContain(t("workflows.edit.withAgent"));
    expect(markup).toContain(t("workflows.startNow"));
    expect(markup.indexOf(t("workflows.edit.withAgent"))).toBeLessThan(
      markup.indexOf(t("workflows.startNow"))
    );
    expect(page({}, "de")).toContain("Mit dem Agenten bearbeiten");
  });

  it("offers no conversation to a reader who may not write the Workflow", () => {
    const markup = page({ offered: false });
    expect(markup).not.toContain(t("workflows.edit.withAgent"));
    expect(markup).toContain(t("workflows.startNow"));
  });

  it("says in place that the instance made no conversation, as an alert", () => {
    const markup = page({ edit: { error: t("workflows.edit.refused") } });
    expect(markup).toContain("data-edit-refused");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain(t("workflows.edit.refused"));
    expect(page()).not.toContain("data-edit-refused");
  });

  it("says that the draft differs from what is published, with the publish and the discard", () => {
    const markup = page({ draft: { state: "ahead", onPublish: noop, onDiscard: noop } });
    expect(markup).toContain('data-workflow-draft="ahead"');
    expect(markup).toContain("Draft differs from published");
    expect(markup).toContain(t("workflows.draft.aheadBody"));
    expect(markup).toContain(`>${t("workflows.draft.publish")}</`);
    expect(markup).toContain(`>${t("workflows.draft.discard")}</`);
    const german = page({ draft: { state: "ahead", onPublish: noop, onDiscard: noop } }, "de");
    expect(german).toContain(de("workflows.draft.ahead"));
    expect(german).toContain(`>${de("workflows.draft.publish")}</`);
  });

  it("says it without a button to a reader who may neither publish nor discard", () => {
    const markup = page({ draft: { state: "ahead" } });
    expect(markup).toContain(t("workflows.draft.ahead"));
    expect(markup).not.toContain(`>${t("workflows.draft.publish")}</`);
    expect(markup).not.toContain(`>${t("workflows.draft.discard")}</`);
  });

  it("says of a draft that was never published what is true of it, and offers no discard", () => {
    const markup = page({
      workflow: unpublished,
      draft: { state: "unpublished", onPublish: noop }
    });
    expect(markup).toContain('data-workflow-draft="unpublished"');
    expect(markup).toContain(t("workflows.draft.unpublished"));
    expect(markup).not.toContain(t("workflows.draft.ahead"));
    expect(markup).not.toContain(`>${t("workflows.draft.discard")}</`);
  });

  it("shows no bar where the draft is the published revision", () => {
    expect(page({ workflow: level })).not.toContain("data-workflow-draft");
  });

  it("asks once before a publish and before a discard, and answers a refusal in the question", () => {
    const dialog = (change: "publish" | "discard", error?: string) =>
      render(
        createElement(DraftChangeDialog, {
          change,
          name: "Month end",
          revision: 6,
          publishedRevision: 4,
          loading: false,
          error,
          onConfirm: noop,
          onClose: noop
        })
      );
    expect(dialog("publish")).toContain(t("workflows.draft.publishTitle", { name: "Month end" }));
    expect(dialog("publish")).toContain(t("workflows.draft.publishBody", { number: 6 }));
    expect(dialog("discard")).toContain(t("workflows.draft.discardTitle", { name: "Month end" }));
    expect(dialog("discard")).toContain(t("workflows.draft.discardBody", { number: 4 }));
    expect(dialog("publish", "Needs what administering service principals needs")).toContain(
      "Needs what administering service principals needs"
    );
  });

  // ACCEPT-2a C3: with the schedule removed, the publish says no schedule.
  it("says how the published revision starts, and no schedule it does not have", () => {
    const body = (starts?: { byHand: boolean; onSchedule: boolean }) =>
      render(
        createElement(DraftChangeDialog, {
          change: "publish",
          name: "Month end",
          revision: 6,
          publishedRevision: 4,
          ...(starts ? { starts } : {}),
          loading: false,
          error: undefined,
          onConfirm: noop,
          onClose: noop
        })
      );
    const byHand = body({ byHand: true, onSchedule: false });
    expect(byHand).toContain(t("workflows.draft.publishBodyByHand", { number: 6 }));
    expect(byHand).not.toContain("schedule");
    expect(body({ byHand: false, onSchedule: true })).toContain(
      t("workflows.draft.publishBodySchedule", { number: 6 })
    );
    expect(body({ byHand: true, onSchedule: true })).toContain(
      "Revision 6 becomes the version that runs, by hand and on its schedule."
    );
    expect(body()).not.toContain("schedule");
  });

  it("names each limit the draft raises in the publish question, and nothing in the discard", () => {
    const raise = "Raises the run time of each run from 12h to 30h.";
    const dialog = (change: "publish" | "discard", question?: string[]) =>
      render(
        createElement(DraftChangeDialog, {
          change,
          name: "Month end",
          revision: 6,
          publishedRevision: 4,
          ...(question ? { question } : {}),
          loading: false,
          error: undefined,
          onConfirm: noop,
          onClose: noop
        })
      );
    expect(dialog("publish", [raise])).toContain(raise);
    expect(dialog("publish", [raise])).toContain(t("workflows.draft.publishRaises"));
    expect(dialog("discard", [raise])).not.toContain(raise);
    expect(dialog("publish")).not.toContain("workflow-publish-question");
  });
});
