import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { ApiError } from "@work-shape/catalyst-api-client";
import { createTranslationContext } from "./support/chat-ui/shared";
import { instanceSentence } from "./support/chat-ui/studio-build-area";
import {
  DraftChangeDialog,
  draftChangesSentence,
  RightsLacking,
  WorkflowPageView,
  createInstanceSource,
  draftState,
  editOffered,
  giveFailureSentence,
  toWorkflow,
  workflowPublishRefusal,
  type WorkflowPublishRightsView
} from "@work-shape/catalyst-chat-ui/workflows";
import { ACTIONS } from "@work-shape/catalyst-core";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { recordedApiClient } from "./support/recorded-api-client";

// The draft of a Workflow on its page and over the instance: who is offered the conversation in
// which the agent changes it, what the bar says of a draft that is not the published revision,
// what its publish sends and asks, the rights its technical accounts lack (with the one step
// that gives them), and the Data Store drafts one Publish makes live with it (LIVE-2).

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

describe("how the draft of a Workflow stands, and who may edit it with the agent", () => {
  it("says ahead, unpublished or nothing, by the two pointers the instance names", () => {
    expect(ahead.draft).toEqual({
      revision: 6,
      publishedRevision: 4,
      testForm: { fields: [], unsupported: [] }
    });
    expect(draftState(ahead)).toBe("ahead");
    expect(draftState(level)).toBeUndefined();
    expect(unpublished.draft).toEqual({ revision: 1, testForm: { fields: [], unsupported: [] } });
    expect(draftState(unpublished)).toBe("unpublished");
    expect(publishedView.draft).toBeUndefined();
    expect(draftState(publishedView)).toBeUndefined();
    expect(draftState(undefined)).toBeUndefined();
  });

  it("offers the edit to a writer shown the draft, and to nobody else", () => {
    const writes = (write: boolean) => ({
      instance: { read: true, write, publish: false, delete: false }
    });
    expect(editOffered(writes(true), ahead)).toBe(true);
    expect(editOffered(writes(true), level)).toBe(true);
    expect(editOffered(writes(true), unpublished)).toBe(true);
    expect(editOffered(writes(false), ahead)).toBe(false);
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
        case "assets.list":
        case "workflows.list":
          return { items: [] };
        default:
          return { draftRevision: 6, publishedRevision: 6 };
      }
    });
    return { source: createInstanceSource(client, "k"), calls };
  };

  it("reads the pointers of the draft, its publish question and its pending stores from the read of the asset", async () => {
    const raise = "Raises the run time of each run from 12h to 30h.";
    const findings = {
      name: "findings",
      title: "Findings",
      revision: 3,
      publishedRevision: 2,
      liveLevel: 1,
      pendingMigrations: ["add_note"]
    };
    const { source } = instance({
      ...asset,
      publishQuestion: [raise],
      publishDataStores: [findings]
    });
    const workflow = await source.getWorkflow("cw_1", "month-end", signal);
    expect(workflow.draft).toMatchObject({ revision: 6, publishedRevision: 4 });
    expect(draftState(workflow)).toBe("ahead");
    expect(workflow.draft?.publishQuestion).toEqual([raise]);
    expect(workflow.draft?.publishDataStores).toEqual([
      { name: "findings", title: "Findings", revision: 3, pendingMigrations: ["add_note"] }
    ]);
  });

  it("names no draft where the instance answered the published view", async () => {
    const { draftRevision: _left, ...publishedAnswer } = { ...asset, revision: 4 };
    const { source } = instance(publishedAnswer);
    const workflow = await source.getWorkflow("cw_1", "month-end", signal);
    expect(workflow.draft).toBeUndefined();
    expect(workflow.published).toBe(true);
  });

  it("publishes the revision the page read, with each store at the revision the question showed", async () => {
    const { source, calls } = instance();
    await source.drafts?.publish("month-end", 6);
    await source.drafts?.publish("month-end", 6, undefined, [{ name: "findings", revision: 3 }]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      operation: "assets.publish",
      params: { kind: "workflow", name: "month-end" }
    });
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ revision: 6 });
    expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({
      revision: 6,
      dataStores: [{ name: "findings", revision: 3 }]
    });
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
  const edit = {
    busy: false,
    error: undefined as string | undefined,
    start: noop,
    startWith: noop,
    dismissError: noop
  };
  const page = (
    input: {
      workflow?: typeof ahead;
      edit?: Partial<typeof edit>;
      draft?: {
        state: "ahead" | "unpublished";
        onPublish?: () => void;
        onDiscard?: () => void;
        liveVersion?: { number: number; publishedAt?: string; by?: string };
        testCopies?: readonly { name: string; title: string }[];
      };
    } = {}
  ) =>
    render(
      createElement(WorkflowPageView, {
        workspaceId: "cw_1",
        workflowId: "month-end",
        read: { workflow: input.workflow ?? ahead, problem: undefined, retry: noop },
        runsAvailable: true,
        edit: { ...edit, ...input.edit },
        draft: input.draft,
        onOpenChild: noop,
        onOpenRoute: noop,
        onStart: noop
      })
    );
  const publishButton = `>${t("workflows.draft.publish")}</`;
  const discardButton = `>${t("workflows.draft.discard")}</`;

  it("says in place that the instance made no conversation, as an alert", () => {
    const markup = page({ edit: { error: t("workflows.edit.refused") } });
    expect(markup).toContain("data-edit-refused");
    expect(markup).toContain('role="alert"');
    expect(page()).not.toContain("data-edit-refused");
  });

  // DT-1b, Workflows check 6: the page head offers the publish, the discard in its menu.
  it("offers the publish in the head to who may publish, never the discard as a button, and neither to a reader", () => {
    const publisher = page({ draft: { state: "ahead", onPublish: noop, onDiscard: noop } });
    expect(publisher).toContain('data-workflow-draft="ahead"');
    expect(publisher).toContain(publishButton);
    expect(publisher).not.toContain(discardButton);
    const reader = page({ draft: { state: "ahead" } });
    expect(reader).toContain("data-draft-header");
    expect(reader).not.toContain(publishButton);
    expect(reader).not.toContain(discardButton);
    const never = page({ workflow: unpublished, draft: { state: "unpublished", onPublish: noop } });
    expect(never).toContain('data-workflow-draft="unpublished"');
    expect(never).not.toContain(discardButton);
    expect(page({ workflow: level })).not.toContain("data-workflow-draft");
  });

  // DT-2 in the head: a store whose test copy the draft writes to is named, with its page.
  it("links each test copy the draft's changing calls write to", () => {
    const markup = page({
      draft: { state: "ahead", testCopies: [{ name: "invoices", title: "Invoices" }] }
    });
    expect(markup).toMatch(
      /href="[^"]*\/build\/data-stores\/invoices"[^>]*data-draft-test-target="copy"/u
    );
  });

  it("counts what the draft changes against the live version, and says nothing without changes", () => {
    const changes: Parameters<typeof draftChangesSentence>[0] = {
      steps: new Map([
        ["a", "new"],
        ["b", "changed"],
        ["c", "changed"],
        ["d", "removed"]
      ]),
      fields: new Map(),
      removed: []
    };
    expect(draftChangesSentence(changes, "en", t)).toContain("2 changed steps");
    expect(draftChangesSentence(undefined, "en", t)).toBeUndefined();
  });
});

describe("the question before a publish or a discard", () => {
  const dialog = (
    change: "publish" | "discard",
    more: Partial<Parameters<typeof DraftChangeDialog>[0]> = {}
  ) =>
    render(
      createElement(DraftChangeDialog, {
        change,
        name: "Month end",
        revision: 6,
        publishedRevision: 4,
        loading: false,
        error: undefined,
        onConfirm: noop,
        onClose: noop,
        ...more
      })
    );

  it("answers a refusal in the question", () => {
    expect(
      dialog("publish", { error: "Needs what administering service principals needs" })
    ).toContain("Needs what administering service principals needs");
  });

  // DT-1b, Apps check 45 for a Workflow: the publish lists each step that changes something,
  // new or changed, and the outside hosts it calls for the first time.
  it("lists the changing steps the publish makes live and the hosts it adds", () => {
    const markup = dialog("publish", {
      changing: [
        { label: "Write the invoice", change: "new" },
        { label: "Send the reminder", change: "changed" }
      ],
      hostsAdded: ["api.example.com"]
    });
    expect(markup).toContain('data-change-item="Write the invoice"');
    expect(markup).toContain('data-change-item="Send the reminder"');
    expect(markup).toContain('data-change-item="api.example.com"');
  });

  // ACCEPT-2a C3: with the schedule removed, the publish says no schedule.
  it("says no schedule the published revision does not have", () => {
    expect(dialog("publish", { starts: { byHand: true, onSchedule: false } })).not.toContain(
      "schedule"
    );
    expect(dialog("publish", { starts: { byHand: false, onSchedule: true } })).toContain(
      "schedule"
    );
    expect(dialog("publish")).not.toContain("schedule");
  });

  it("names each limit the draft raises in the publish question, and nothing in the discard", () => {
    const raise = "Raises the run time of each run from 12h to 30h.";
    expect(dialog("publish", { question: [raise] })).toContain(raise);
    expect(dialog("discard", { question: [raise] })).not.toContain(raise);
  });

  // LIVE-2: one Publish of the Workflow publishes the Data Store drafts its steps call first and
  // applies their migrations; a migration that fails says that the Workflow is not published.
  it("names each store it publishes first with its migrations, beside the account line", () => {
    const account = "Runs as its own account “Import findings” and may add rows to Findings.";
    const store = {
      name: "findings",
      title: "Findings",
      revision: 3,
      publishedRevision: 2,
      liveLevel: 1,
      pendingMigrations: ["add_note", "add_due"]
    };
    const markup = dialog("publish", {
      question: [account],
      stores: [store, { ...store, name: "clients", title: "Clients", pendingMigrations: [] }]
    });
    expect(markup).toContain("add_note");
    expect(markup).toContain("add_due");
    expect(markup).toContain(t("workflows.draft.publishStore", { title: "Clients" }));
    expect(markup).toContain(account);
  });

  it("says that the Workflow is not published when a store's migration fails", () => {
    const refusal = (publishing?: "workflow") =>
      new ApiError(409, "refused", {
        error: {
          code: "CONFLICT",
          message: "The migration failed.",
          details: {
            reason: "data_store_migration_failed",
            dataStore: "findings",
            title: "Findings",
            migration: "add_note",
            level: 1,
            ...(publishing ? { publishing } : {})
          }
        }
      });
    expect(instanceSentence(refusal("workflow"), t)).toBe(
      t("refusals.dataStoreMigrationFailedWorkflow", {
        dataStore: "Findings",
        migration: "add_note"
      })
    );
    // An App's Publish keeps its own sentence.
    expect(instanceSentence(refusal(), t)).not.toBe(instanceSentence(refusal("workflow"), t));
  });
});

// The question before a Workflow is published names, in the reader's words, the rights its
// technical accounts lack, and offers the one step that gives them to whoever may.
describe("the rights the technical accounts of a publish lack", () => {
  const rightId = new RegExp(
    `(?<![\\w.])(${ACTIONS.map((a) => a.replace(/\./gu, "\\.")).join("|")})(?![\\w])`,
    "u"
  );
  const never = () => Promise.resolve();
  const lacking = (administers: boolean): WorkflowPublishRightsView => ({
    administers,
    hiddenWorkflows: 0,
    workflows: [
      {
        workflow: "parent",
        revision: "draft",
        runAs: "workflow-runner",
        account: { label: "Workflow runner", status: "active" },
        rights: [
          {
            action: "workflow.use",
            asset: { kind: "workflow", name: "child" },
            steps: ["child"],
            neededFor: "publish",
            held: false,
            ...(administers
              ? { grant: { holderId: "sp_secret_id", scopeId: "asset_secret_id" } }
              : { refusal: "not_administrator" as const })
          }
        ]
      },
      {
        workflow: "child",
        revision: "published",
        runAs: "workflow-runner",
        account: { label: "Workflow runner", status: "active" },
        rights: [
          {
            action: "connection.use",
            asset: { kind: "connection", name: "exampledata" },
            steps: ["read"],
            neededFor: "run",
            held: false,
            refusal: administers ? ("not_held" as const) : ("not_administrator" as const)
          },
          {
            action: "data_store.insert",
            asset: { kind: "data_store", name: "mandanten" },
            steps: ["store"],
            neededFor: "run",
            held: true
          }
        ]
      }
    ]
  });
  const rights = (view: WorkflowPublishRightsView, locale: "en" | "de" = "en") =>
    render(createElement(RightsLacking, { view, give: never, onGiven: never }), locale);

  it("names each lacking right on its resource, offers the give step, and never a right's id or a grant's ids", () => {
    const en = rights(lacking(true));
    expect(en).toContain("Workflow child");
    expect(en).toContain("Connection exampledata");
    expect(en).not.toContain("mandanten");
    expect(en).toContain('data-testid="workflow-publish-rights-give"');
    for (const markup of [en, rights(lacking(true), "de")]) {
      expect(markup).not.toMatch(rightId);
      expect(markup).not.toContain("sp_secret_id");
      expect(markup).not.toContain("asset_secret_id");
    }
  });

  it("offers no step to a reader who administers no account", () => {
    expect(rights(lacking(false))).not.toContain('data-testid="workflow-publish-rights-give"');
  });

  it("counts the child Workflows the reader cannot see and names no resource it cannot see", () => {
    const only = rights({ administers: false, hiddenWorkflows: 2, workflows: [] });
    // A hidden child alone still says something is missing, never that all is held.
    expect(only).toContain("2 child workflows you cannot see");
    expect(only).not.toContain("hold every right");
    const held: WorkflowPublishRightsView = {
      administers: true,
      hiddenWorkflows: 0,
      workflows: lacking(true).workflows.map((entry) => ({
        ...entry,
        rights: entry.rights.map((right) => ({ ...right, held: true }))
      }))
    };
    expect(rights(held, "de")).toContain("Die Technischen Konten haben jedes Recht");
  });

  it("says a refused publish in the reader's language, never by its reason, right id or the instance's sentence", () => {
    const refusal = (code: string, details: Record<string, string>) =>
      new ApiError(code === "FORBIDDEN" ? 403 : 400, "refused", {
        error: {
          code,
          message: "The parent's principal does not hold workflow.use on the child",
          details
        }
      });
    for (const reason of [
      "child_use_forbidden",
      "no_parent_trigger",
      "child_unpublished",
      "workflow_cycle",
      "run_as_missing",
      "run_as_disabled",
      "user_only"
    ])
      for (const translate of [t, de]) {
        const sentence =
          workflowPublishRefusal(refusal("VALIDATION_FAILED", { reason }), translate) ?? "";
        expect(sentence, reason).not.toBe("");
        expect(sentence, reason).not.toMatch(rightId);
        expect(sentence, reason).not.toContain(reason);
      }
    expect(
      workflowPublishRefusal(
        refusal("FORBIDDEN", { reason: "no_grant", action: "connection.use" }),
        de
      )
    ).toContain("Verbindungen verwenden");
    // A refusal the page has no sentence for is said as the instance said it.
    expect(
      workflowPublishRefusal(
        refusal("FORBIDDEN", { reason: "no_grant", action: "workflow.publish" }),
        t
      )
    ).toBeUndefined();
    // A right on a resource the reader may not see is refused at the grant, and said so.
    const hidden = refusal("FORBIDDEN", { reason: "not_visible", action: "connection.read" });
    expect(giveFailureSentence(hidden, t)).not.toBe(giveFailureSentence(new Error("offline"), t));
    expect(giveFailureSentence(hidden, t)).not.toMatch(rightId);
  });

  it("reads the Workflow's needs and gives each right through the ordinary grant write", async () => {
    const { client, calls } = recordedApiClient(({ operation }) =>
      operation === "workflows.principal_rights"
        ? lacking(true)
        : {
            id: "grant_1",
            holderKind: "service_principal",
            holderId: "sp_1",
            action: "workflow.use",
            effect: "allow",
            scopeKind: "asset",
            scopeId: "asset_1",
            createdAt: "2026-10-18T10:00:00.000Z"
          }
    );
    const source = createInstanceSource(client, "test").publishRights;
    expect(await source?.read("parent", new AbortController().signal)).toEqual(lacking(true));
    await source?.give({ holderId: "sp_1", action: "workflow.use", scopeId: "asset_1" });
    expect(
      calls.map((call) => [
        call.operation,
        call.params,
        call.body ? JSON.parse(call.body) : undefined
      ])
    ).toEqual([
      ["workflows.principal_rights", { workflow: "parent" }, undefined],
      [
        "permissions.grant",
        {},
        {
          holderKind: "service_principal",
          holderId: "sp_1",
          action: "workflow.use",
          effect: "allow",
          scopeKind: "asset",
          scopeId: "asset_1"
        }
      ]
    ]);
  });
});
