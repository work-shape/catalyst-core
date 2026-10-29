import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  NOTICE_KIND,
  asServicePrincipalId,
  createPlatformId,
  type CollaborationWorkspaceId,
  type JsonObject,
  type UserRecord
} from "@work-shape/catalyst-core";
import { parseWorkflowManifest } from "@work-shape/catalyst-workflows";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import {
  clientInstanceId,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";
import { appFiles, expectStatus, setupAppInstance, type AppInstance } from "./support/app-instance";

// Feedback on Apps and on Workflow results (LU-6, limits-usage-analytics-and-feedback.md 3.5):
// a published App sends its viewer's comment through the frame, which names the App; the reader
// of a notice about a Workflow run comments on that run. Both reach the reviewers of the asset
// in the Inbox, and the record, its event and its audit row hold ids, never the text.
// Every test here fails before LU-6: a comment could only be about an agent's answer.

const COMMENT = "The total at the bottom leaves out the open offers.";
const NOTICE_TEXT = "3 findings in the monthly check. Statement 4711 is missing.";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

interface InboxItem {
  id: string;
  kind: string;
  preview?: Record<string, unknown>;
}

async function inbox(at: AccessInstance, user: UserRecord): Promise<InboxItem[]> {
  const listed = await at.call(user.id, "approval_requests.list", {
    query: { status: "pending" }
  });
  if (listed.statusCode === 403) return [];
  expect(listed.statusCode).toBe(200);
  return listed
    .json<{ items: InboxItem[] }>()
    .items.filter((item) => item.kind === "feedback_review");
}

const frameSchema = z.looseObject({
  url: z.string(),
  fileSetId: z.string(),
  pageSessionId: z.string()
});

/** The frame a person is shown the App in, as the interface names it to the instance. */
async function frameOf(t: AppInstance, userId: string, app: string, mode: "draft" | "published") {
  const preview = await t.call(userId, "apps.preview", { params: { app }, payload: { mode } });
  expectStatus(preview, 200);
  const { url, fileSetId, pageSessionId } = frameSchema.parse(preview.json());
  const segments = url.split("/").filter(Boolean);
  const token = segments[segments.indexOf(fileSetId) + 1] ?? "";
  return { pageSessionId, fileSetId, token };
}

function sendFromApp(
  t: AppInstance,
  userId: string,
  frame: { pageSessionId: string; fileSetId: string; token: string },
  text = COMMENT
) {
  return t.call(userId, "feedback.send_from_app", {
    params: { pageSessionId: frame.pageSessionId },
    payload: { fileSetId: frame.fileSetId, token: frame.token, text }
  });
}

async function publishedApp(feedbackOn = true, name = "offers") {
  const t = await setupAppInstance(feedbackOn ? { modules: { feedback: { enabled: true } } } : {});
  close = () => t.close();
  expectStatus(await t.putApp(t.admin.id, name, appFiles("Offers", { id: name })), 200);
  expectStatus(await t.publish(t.admin.id, name, 1), 200);
  return t;
}

describe("feedback from a published App", () => {
  it("names the App and its revision and reaches its reviewers, the workspace's among them", async () => {
    const t = await publishedApp();
    await t.grant(t.lena.id, "feedback.review", { workspaceId: t.workspaceId });
    const appId = await t.assetId("app", "offers");

    const sent = await sendFromApp(t, t.kai.id, await frameOf(t, t.kai.id, "offers", "published"));
    expectStatus(sent, 200);
    const own = sent.json<{ id: string; state: string; includesExchange: boolean }>();
    expect(own).toMatchObject({ state: "new", includesExchange: false });

    for (const reviewer of [t.admin, t.lena]) {
      const [item, ...more] = await inbox(t, reviewer);
      expect(more).toEqual([]);
      expect(item?.preview).toMatchObject({
        feedbackId: own.id,
        subjectKind: "app",
        about: { kind: "app", name: "offers", revision: 1, workspaceId: t.workspaceId },
        text: COMMENT
      });
      // An App has no agent: a reader of LU-4 finds none to filter by.
      expect(item?.preview).not.toHaveProperty("agent");
    }
    // The author does not review their own comment.
    expect(await inbox(t, t.kai)).toEqual([]);

    const [received] = await t.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "feedback.received"
    });
    expect(received).toMatchObject({
      subject: own.id,
      metadata: { feedbackId: own.id, subjectKind: "app", appName: "offers", assetId: appId }
    });
    expect(JSON.stringify(received)).not.toContain(COMMENT);
  });

  it("is refused from a draft, from a frame of somebody else, and with the module off", async () => {
    const t = await publishedApp();
    const draft = await sendFromApp(t, t.admin.id, await frameOf(t, t.admin.id, "offers", "draft"));
    expectStatus(draft, 404);
    expect(draft.json()).toMatchObject({
      error: { details: { reason: "feedback_app_unpublished" } }
    });
    // The frame proves itself to the person it was given to, and to nobody else.
    const kaisFrame = await frameOf(t, t.kai.id, "offers", "published");
    expectStatus(await sendFromApp(t, t.admin.id, kaisFrame), 404);
    expectStatus(await sendFromApp(t, t.kai.id, { ...kaisFrame, token: "x".repeat(32) }), 404);
    expect(await inbox(t, t.admin)).toEqual([]);
    await close?.();

    const off = await publishedApp(false, "quotes");
    const refused = await sendFromApp(
      off,
      off.kai.id,
      await frameOf(off, off.kai.id, "quotes", "published")
    );
    expectStatus(refused, 404);
    expect(refused.json()).toMatchObject({ error: { details: { reason: "module_off" } } });
  });
});

/** A Workflow the workspace owns, a run of it, and the notice of that run in `to`'s Inbox. */
async function reportedRun(
  at: AccessInstance,
  workspaceId: CollaborationWorkspaceId,
  to: UserRecord,
  name = "monthly-check"
) {
  const manifest: JsonObject = {
    id: name,
    name: "Monthly check",
    runAs: "monthly-check",
    inputs: { type: "object" },
    outputs: { type: "object" },
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
      { id: "result", name: "Result", type: "output", input: {} }
    ]
  };
  const parsed = parseWorkflowManifest(manifest);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  await applyAtCurrentRevisions(at.stores.configAssets, {
    clientInstanceId,
    mutations: [
      {
        type: "upsert",
        kind: "workflow",
        name,
        config: { name, manifest },
        scope: { kind: "workspace", workspaceId }
      }
    ]
  });
  const workflow = await at.stores.configAssets.getConfigAsset({
    clientInstanceId,
    kind: "workflow",
    name
  });
  if (!workflow) throw new Error("The Workflow was not written");
  const now = new Date();
  const run = await at.stores.workflowRuns.createRun({
    id: createPlatformId<"WorkflowRunId">("wfr"),
    clientInstanceId,
    workflow: name,
    definitionRevisionId: workflow.activeRevisionId,
    mode: "live",
    trigger: "manual",
    principal: {
      id: asServicePrincipalId("sp_monthly_check"),
      name: "monthly-check",
      displayLabel: "Monthly check"
    },
    startedBy: { kind: "user", id: at.admin.id, label: at.admin.displayLabel },
    deadlineAt: new Date(now.getTime() + 60_000).toISOString(),
    limits: { durationMs: 60_000, stepRuns: 20_000, loopItems: 10_000 },
    correlationId: "corr_feedback_result",
    createdAt: now.toISOString(),
    definition: parsed.manifest,
    input: {}
  });
  if (!run) throw new Error("The run was not written");
  const notice = await at.stores.approvals.createApprovalRequest({
    clientInstanceId,
    kind: NOTICE_KIND,
    summary: "Monthly check",
    payload: {
      title: "Monthly check",
      text: NOTICE_TEXT,
      link: { kind: "workflow_run", workspaceId, workflowId: name, runId: run.id }
    },
    requestedBy: { id: "sp_monthly_check", displayLabel: "Monthly check" },
    addresseeUserId: to.id
  });
  return { runId: run.id, noticeId: notice.id, revision: workflow.revision };
}

describe("feedback on a Workflow result", () => {
  let at: AccessInstance;
  async function setup(feedbackOn = true) {
    at = await setupAccessInstance({ modules: feedbackOn ? { feedback: { enabled: true } } : {} });
    close = () => at.instance.close();
    return at;
  }

  it("is sent once per run by the reader of the notice and reaches the Workflow's reviewers", async () => {
    await setup();
    const workspaceId = await at.sharedWorkspace("Accounting");
    await at.grant(at.lena.id, "feedback.review", { workspaceId });
    const { runId, noticeId, revision } = await reportedRun(at, workspaceId, at.kai);
    // A run of a Workflow another workspace owns, which Lena does not review.
    const elsewhere = await reportedRun(
      at,
      await at.sharedWorkspace("Elsewhere"),
      at.kai,
      "weekly-check"
    );
    const onElsewhere = await at.expectOk(at.kai.id, "feedback.send_on_result", {
      params: { requestId: elsewhere.noticeId },
      payload: { text: COMMENT }
    });
    const params = { requestId: noticeId };

    const none = await at.expectOk(at.kai.id, "feedback.list_own_on_result", { params });
    expect(none.json()).toEqual({ items: [] });
    const sent = await at.expectOk(at.kai.id, "feedback.send_on_result", {
      params,
      payload: { text: COMMENT }
    });
    const own = sent.json<{ id: string; state: string }>();
    expect(own.state).toBe("new");
    const again = await at.call(at.kai.id, "feedback.send_on_result", {
      params,
      payload: { text: "Once more." }
    });
    expect(again.statusCode).toBe(409);
    const listed = await at.expectOk(at.kai.id, "feedback.list_own_on_result", { params });
    expect(listed.json()).toMatchObject({ items: [{ id: own.id, state: "new" }] });

    // The reviewers of the Workflow; a workspace's reviewer reads nothing of another's.
    expect((await inbox(at, at.admin)).map((item) => item.preview?.feedbackId).sort()).toEqual(
      [own.id, onElsewhere.json<{ id: string }>().id].sort()
    );
    {
      const [item, ...more] = await inbox(at, at.lena);
      expect(more).toEqual([]);
      expect(item?.preview).toMatchObject({
        feedbackId: own.id,
        subjectKind: "workflow_run",
        about: {
          kind: "workflow",
          name: "monthly-check",
          displayName: "Monthly check",
          revision,
          workspaceId
        },
        workflowRunId: runId,
        text: COMMENT
      });
    }

    // Nothing of the run or the notice is copied: the event names the run by its id.
    const received = (
      await at.stores.audit.listAuditEvents({ clientInstanceId, type: "feedback.received" })
    ).find((event) => event.subject === own.id);
    expect(received).toMatchObject({
      metadata: { subjectKind: "workflow_run", workflowName: "monthly-check", workflowRunId: runId }
    });
    const written = JSON.stringify(received);
    expect(written).not.toContain(COMMENT);
    expect(written).not.toContain(NOTICE_TEXT);
    const record = await at.stores.feedback.getFeedback({ clientInstanceId, id: own.id });
    expect(JSON.stringify(record)).not.toContain(NOTICE_TEXT);
  });

  it("is refused on somebody else's notice, on an item that is no notice of a run, and with the module off", async () => {
    await setup();
    const workspaceId = await at.sharedWorkspace("Accounting");
    const { noticeId } = await reportedRun(at, workspaceId, at.kai);
    const params = { requestId: noticeId };
    const payload = { text: COMMENT };

    expect(
      (await at.call(at.lena.id, "feedback.send_on_result", { params, payload })).statusCode
    ).toBe(404);
    expect((await at.call(at.lena.id, "feedback.list_own_on_result", { params })).statusCode).toBe(
      404
    );
    const appNotice = await at.stores.approvals.createApprovalRequest({
      clientInstanceId,
      kind: NOTICE_KIND,
      summary: "Findings",
      payload: {
        title: "Findings",
        text: NOTICE_TEXT,
        link: { kind: "app", workspaceId, app: "findings" }
      },
      requestedBy: { id: "sp_monthly_check", displayLabel: "Monthly check" },
      addresseeUserId: at.kai.id
    });
    expect(
      (
        await at.call(at.kai.id, "feedback.send_on_result", {
          params: { requestId: appNotice.id },
          payload
        })
      ).statusCode
    ).toBe(404);
    expect(await inbox(at, at.admin)).toEqual([]);
    await close?.();

    await setup(false);
    const off = await reportedRun(at, await at.sharedWorkspace("Quiet"), at.kai, "quiet-check");
    const refused = await at.call(at.kai.id, "feedback.send_on_result", {
      params: { requestId: off.noticeId },
      payload
    });
    expect(refused.statusCode).toBe(404);
    expect(refused.json()).toMatchObject({ error: { details: { reason: "module_off" } } });
  });
});
