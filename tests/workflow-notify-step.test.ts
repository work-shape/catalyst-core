import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { clientInstanceId } from "./support/access-instance";
import { runSchema, workflowFixture, type WorkflowFixture } from "./support/workflow-instance";
import { required } from "./support/assertions";
import { stepRunsOf } from "./support/workflow-runs";

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
  it("resolves mapped text and uses the principal, while a draft test addresses only the tester", async () => {
    const t = await ready();
    const manifest = definition("notice-flow", [
      {
        id: "notify",
        name: "Notify",
        type: "notify",
        to: { users: [t.admin.id] },
        channels: ["inbox"],
        title: { value: "Private title" },
        text: { ref: { step: "start", path: "input.text" } },
        link: { kind: "run" }
      }
    ]);
    await save(t, manifest);
    const review = z.object({ publishQuestion: z.array(z.string()) }).parse(
      (
        await t.expectOk(t.root.id, "assets.get", {
          params: { kind: "workflow", name: manifest.id }
        })
      ).json()
    );
    expect(review.publishQuestion.join(" ")).toContain(t.admin.id);
    expect(review.publishQuestion.join(" ")).toContain("inbox");
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
    expect(await items(t, t.root.id)).toMatchObject([
      { summary: "Private title", preview: { text: "Test paragraph" } }
    ]);
    expect(await items(t, t.admin.id)).toHaveLength(1);
    // A later pass / recovered job creates no duplicate for a settled step.
    await worker.runDue();
    expect(await items(t, t.admin.id)).toHaveLength(1);
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
      { preview: { text: expect.stringContaining("1 run(s)") } }
    ]);
    expect((await stepRunsOf(t, run.id)).find((step) => step.stepId === "notify")?.status).toBe(
      "failed"
    );
  });

  it("creates exactly one notice for fifty failed children even when the root failure job runs twice", async () => {
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
          payload: { input: { items: Array.from({ length: 50 }, (_, index) => index) } }
        })
      ).json()
    );
    const worker = t.worker();
    expect((await t.finish(run.id, worker, 1500)).status).toBe("done");
    await worker.runDue();
    expect(await items(t, t.root.id)).toMatchObject([
      { preview: { text: expect.stringContaining("50 run(s)") } }
    ]);
    expect(await items(t, t.root.id)).toHaveLength(1);
    expect(
      await t.stores.workflowNotices.failureCount({
        clientInstanceId,
        rootRunId: run.id
      })
    ).toBe(50);
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
  });
});
