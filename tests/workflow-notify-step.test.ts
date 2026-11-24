import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { clientInstanceId } from "./support/access-instance";
import { runSchema, workflowFixture, type WorkflowFixture } from "./support/workflow-instance";
import { withTestSql } from "./support/test-sql";
import { required } from "./support/assertions";
import {
  failingFor,
  notifyClients,
  readyWorkflows,
  start,
  stepRunsOf
} from "./support/workflow-runs";

let fixture: WorkflowFixture | undefined;
afterEach(async () => {
  await fixture?.instance.close();
  fixture = undefined;
});
const trigger = { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] };
const output = { id: "result", name: "Result", type: "output", input: {} };
function definition(id: string, steps: unknown[]) {
  return {
    id,
    name: id,
    runAs: "workflow-runner",
    inputs: { type: "object" },
    outputs: { type: "object" },
    steps: [trigger, ...steps, output]
  };
}
async function save(t: WorkflowFixture, manifest: ReturnType<typeof definition>, publish = true) {
  const params = { kind: "workflow", name: manifest.id };
  const written = await t.expectOk(t.admin.id, "assets.put", {
    params,
    payload: { config: { name: manifest.id, manifest }, expectedRevision: null }
  });
  const { revision } = z.object({ revision: z.number() }).parse(written.json());
  if (publish) await t.expectOk(t.root.id, "assets.publish", { params, payload: { revision } });
}
async function items(t: WorkflowFixture, userId: string) {
  return z
    .object({
      items: z.array(
        z.object({ summary: z.string(), preview: z.object({ text: z.string() }).loose() }).loose()
      )
    })
    .parse((await t.expectOk(userId, "approval_requests.list")).json()).items;
}
async function ready() {
  fixture = await workflowFixture({ definitions: "assets" });
  return fixture;
}

describe("Workflow notify steps and grouped failure notices", () => {
  it("sends live as the principal, while a draft test simulates the intended recipients without Inbox or mail writes", async () => {
    const t = await ready();
    const manifest = definition("notice-flow", [
      {
        id: "notify",
        name: "Notify",
        type: "notify",
        to: { users: [t.admin.id] },
        channels: ["inbox", "mail"],
        title: { value: "Private title" },
        text: { ref: { step: "start", path: "input.text" } },
        link: { kind: "run" }
      }
    ]);
    await save(t, manifest);
    const live = runSchema.parse(
      (
        await t.expectOk(t.root.id, "workflows.start", {
          params: { workflow: manifest.id },
          payload: { input: { text: "Private paragraph" } }
        })
      ).json()
    );
    const worker = t.worker();
    expect((await t.finish(live.id, worker)).status).toBe("done");
    expect(await items(t, t.admin.id)).toMatchObject([
      {
        summary: "Private title",
        requestedBy: { id: t.principal.id },
        preview: { text: "Private paragraph" }
      }
    ]);
    const test = runSchema.parse(
      (
        await t.expectOk(t.root.id, "workflows.test", {
          params: { workflow: manifest.id },
          payload: { input: { text: "Test paragraph" } }
        })
      ).json()
    );
    expect((await t.finish(test.id, worker)).status).toBe("done");
    expect(await items(t, t.root.id)).toEqual([]);
    const simulated = required(
      (await stepRunsOf(t, test.id)).find((step) => step.stepId === "notify")
    );
    expect(simulated).toMatchObject({
      status: "done",
      effect: "changing",
      target: "dry_run"
    });
    expect(JSON.parse(required(simulated.outputPreview).text)).toEqual({
      wouldHaveDone: {
        operation: "notify",
        input: {
          to: { users: [t.admin.id] },
          channels: ["inbox", "mail"],
          title: "Private title",
          text: "Test paragraph"
        }
      }
    });
    expect(
      await t.instance.stores.noticeMail.dueRecipients({
        clientInstanceId,
        now: "2099-01-01T00:00:00.000Z",
        limit: 100
      })
    ).not.toContain(t.root.id);
    expect(await items(t, t.admin.id)).toHaveLength(1);
    // A later pass / recovered job creates no duplicate for a settled step.
    await worker.runDue();
    expect(await items(t, t.admin.id)).toHaveLength(1);
  });

  it("keeps a failed draft test out of failure notices, Inbox and mail", async () => {
    const t = await ready();
    const manifest = {
      ...definition("failed-draft-test", []),
      outputs: {
        type: "object",
        required: ["missing"],
        properties: { missing: { type: "string" } }
      }
    };
    await save(t, manifest);
    const run = runSchema.parse(
      (
        await t.expectOk(t.root.id, "workflows.test", {
          params: { workflow: manifest.id },
          payload: { input: {} }
        })
      ).json()
    );
    const worker = t.worker();
    expect((await t.finish(run.id, worker)).status).toBe("failed");
    await worker.runDue();
    await withTestSql(async (sql) => {
      expect(
        await sql`select root_run_id from workflow_failure_notices where root_run_id = ${run.id}`
      ).toEqual([]);
      expect(
        await sql`select id from platform_jobs where kind = 'workflow_run.notify_failure' and subject = ${run.id}`
      ).toEqual([]);
      // A job queued by an older worker must also be harmless after this release.
      await sql`insert into platform_jobs (id, client_instance_id, kind, payload, subject, correlation_id, status, run_after, max_attempts, created_at)
        select 'legacy-test-notice', client_instance_id, 'workflow_run.notify_failure', jsonb_build_object('rootRunId', id), id, correlation_id, 'queued', now(), 3, now() from workflow_runs where id = ${run.id}`;
    });
    await worker.runDue();
    await withTestSql(async (sql) => {
      expect(
        await sql`select root_run_id from workflow_failure_notices where root_run_id = ${run.id}`
      ).toEqual([]);
    });
    expect(await items(t, t.root.id)).toEqual([]);
    expect(await items(t, t.admin.id)).toEqual([]);
    expect(
      await t.instance.stores.noticeMail.dueRecipients({
        clientInstanceId,
        now: "2099-01-01T00:00:00.000Z",
        limit: 100
      })
    ).toEqual([]);
  });

  it("fails invalid mapped content without echoing it, then notifies the publisher rather than the draft author", async () => {
    const t = await ready();
    const manifest = definition("invalid-notice", [
      {
        id: "notify",
        name: "Notify",
        type: "notify",
        to: { users: [t.admin.id] },
        channels: ["inbox"],
        title: { value: "Sensitive" },
        text: { value: { secret: "Sensitive data" } }
      }
    ]);
    await save(t, manifest);
    const run = runSchema.parse(
      (
        await t.expectOk(t.root.id, "workflows.start", {
          params: { workflow: manifest.id },
          payload: { input: {} }
        })
      ).json()
    );
    const worker = t.worker();
    const ended = await t.finish(run.id, worker);
    expect(ended.status).toBe("failed");
    expect(ended.error?.code).toBe("notice_invalid");
    expect(JSON.stringify(ended.error)).not.toContain("Sensitive");
    await worker.runDue();
    expect(await items(t, t.admin.id)).toEqual([]);
    expect(await items(t, t.root.id)).toMatchObject([
      {
        summary: "A Workflow run needs attention",
        preview: {
          text: expect.stringMatching(/^1 run /u)
        }
      }
    ]);
    expect((await stepRunsOf(t, run.id)).find((step) => step.stepId === "notify")?.status).toBe(
      "failed"
    );
  });

  it("notifies the publisher when a done run has only failed operation items", async () => {
    const t = await readyWorkflows(
      (opened) => {
        fixture = opened;
      },
      { definitions: "assets" }
    );
    await save(t, notifyClients({ onItemFailure: "continue" }));
    t.setBehaviour(failingFor(["client-bert"]));
    const worker = t.worker();
    const run = await t.finish((await start(t)).id, worker);
    expect(run.status).toBe("done");
    await worker.runDue();
    const stored = await t.stores.workflowRuns.readRun({ clientInstanceId, id: run.id });
    if (!stored) throw new Error("Missing completed run");
    expect(
      await t.stores.workflowRuns.listChildRuns({ clientInstanceId, id: stored.id })
    ).toHaveLength(0);
    expect(await items(t, t.root.id)).toMatchObject([
      {
        summary: "A Workflow run needs attention",
        preview: {
          text: expect.stringMatching(/^1 run /u)
        }
      }
    ]);
  });

  describe("one open failure notice per Workflow and publisher", () => {
    const failing = (id: string) => ({
      ...definition(id, []),
      outputs: {
        type: "object",
        required: ["missing"],
        properties: { missing: { type: "string" } }
      }
    });
    async function fail(
      t: WorkflowFixture,
      workflow: string,
      worker: ReturnType<WorkflowFixture["worker"]>
    ) {
      const run = runSchema.parse(
        (
          await t.expectOk(t.root.id, "workflows.start", {
            params: { workflow },
            payload: { input: {} }
          })
        ).json()
      );
      expect((await t.finish(run.id, worker)).status).toBe("failed");
      await worker.runDue();
      return run.id;
    }
    async function open(t: WorkflowFixture) {
      const listed = z
        .object({
          items: z.array(
            z
              .object({
                id: z.string(),
                status: z.string(),
                summary: z.string(),
                preview: z
                  .object({
                    text: z.string(),
                    link: z.object({ workflowId: z.string(), runId: z.string() }).loose()
                  })
                  .loose()
              })
              .loose()
          )
        })
        .parse((await t.expectOk(t.root.id, "approval_requests.list")).json()).items;
      return listed.filter((item) => item.status === "pending");
    }

    it("counts a second failing run into the open notice, links it and moves it to the top, per Workflow", async () => {
      const t = await ready();
      await save(t, failing("hourly-a"));
      await save(t, failing("hourly-b"));
      const worker = t.worker();
      await fail(t, "hourly-a", worker);
      await fail(t, "hourly-b", worker);
      const latest = await fail(t, "hourly-a", worker);
      expect(await open(t)).toMatchObject([
        {
          summary: "Workflow runs need attention",
          preview: {
            text: expect.stringMatching(/^2 runs /u),
            link: { workflowId: "hourly-a", runId: latest }
          }
        },
        {
          summary: "A Workflow run needs attention",
          preview: { link: { workflowId: "hourly-b" } }
        }
      ]);
    }, 120_000);

    it("opens a fresh notice for the next failing run once the person marked it handled", async () => {
      const t = await ready();
      await save(t, failing("hourly-c"));
      const worker = t.worker();
      await fail(t, "hourly-c", worker);
      await fail(t, "hourly-c", worker);
      const [first] = await open(t);
      await t.expectOk(t.root.id, "approval_requests.decide", {
        params: { requestId: required(first).id },
        payload: { decision: "approve" }
      });
      expect(await open(t)).toEqual([]);
      const next = await fail(t, "hourly-c", worker);
      const fresh = await open(t);
      expect(fresh).toMatchObject([
        {
          summary: "A Workflow run needs attention",
          preview: {
            text: expect.stringMatching(/^1 run /u),
            link: { runId: next }
          }
        }
      ]);
      expect(required(fresh[0]).id).not.toBe(required(first).id);
      // A later failing run counts into the fresh notice, not the handled one.
      await fail(t, "hourly-c", worker);
      expect(await open(t)).toMatchObject([
        { id: required(fresh[0]).id, preview: { text: expect.stringMatching(/^2 runs/u) } }
      ]);
    }, 120_000);
  });

  it("creates exactly one notice for five failed children even when the root failure job runs twice", async () => {
    const t = await ready();
    const child = {
      ...definition("bad-child", []),
      outputs: {
        type: "object",
        required: ["missing"],
        properties: { missing: { type: "string" } }
      },
      steps: [{ ...trigger, triggers: [{ kind: "parent" }] }, output]
    };
    await save(t, child);
    await t.allow({ kind: "service_principal", id: t.principal.id }, "workflow.use");
    const parent = definition("parent-notice", [
      {
        id: "each",
        name: "Each",
        type: "loop",
        items: { step: "start", path: "input.items" },
        concurrency: 4,
        onItemFailure: "continue",
        steps: [{ id: "child", name: "Child", type: "workflow", workflow: child.id, input: {} }]
      }
    ]);
    await save(t, parent);
    const run = runSchema.parse(
      (
        await t.expectOk(t.root.id, "workflows.start", {
          params: { workflow: parent.id },
          payload: { input: { items: Array.from({ length: 5 }, (_, index) => index) } }
        })
      ).json()
    );
    const worker = t.worker();
    expect((await t.finish(run.id, worker, 1500)).status).toBe("done");
    await worker.runDue();
    expect(await items(t, t.root.id)).toMatchObject([
      {
        summary: "Workflow runs need attention",
        preview: {
          text: expect.stringMatching(/^6 runs /u)
        }
      }
    ]);
    expect(await items(t, t.root.id)).toHaveLength(1);
    expect(
      await t.stores.workflowNotices.failureCount({
        clientInstanceId,
        rootRunId: run.id
      })
    ).toBe(6);
    // A new job for the same root must run the handler again, not merely poll an empty queue.
    const handler = required(
      t.workflows.jobHandlers.find((entry) => entry.kind.kind === "workflow_run.notify_failure")
    );
    const repeated = await t.stores.jobs.enqueue(
      handler.kind,
      { rootRunId: run.id },
      { clientInstanceId }
    );
    await worker.runDue();
    const overview = await t.stores.jobs.listOverview({ clientInstanceId });
    expect(overview.find((job) => job.id === repeated.id)?.status).toBe("succeeded");
    expect(await items(t, t.root.id)).toHaveLength(1);
  }, 120_000);
});
