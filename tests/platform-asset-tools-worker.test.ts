import { asUserId } from "@work-shape/catalyst-core";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  createAssetToolsFixture,
  subject,
  WORKFLOW,
  configOf,
  added,
  readSchema,
  writeSchema
} from "./support/platform-asset-tools";

it("tests its subject and reads, writes and audits its asset through one separate agent-run worker", async () => {
  const t = await createAssetToolsFixture("separate");
  const { id } = z.object({ id: z.string() }).parse((await t.ok(t.converse(subject))).json());
  const started = z
    .object({ id: z.string(), mode: z.literal("test") })
    .parse(
      await t.call(id, "workflows.test", { workflow: WORKFLOW, input: { note: "Worker test" } })
    );
  expect(await t.call(id, "workflows.get_run", { runId: started.id })).toMatchObject({
    id: started.id,
    mode: "test"
  });
  expect(await t.call(id, "workflows.list_step_runs", { runId: started.id })).toMatchObject({
    items: expect.arrayContaining([expect.objectContaining({ stepId: "start" })])
  });

  const read = readSchema.parse(await t.call(id, "platform.assets.get"));
  expect(read).toMatchObject({
    config: { name: WORKFLOW },
    revision: t.published,
    shows: "published"
  });
  const saved = writeSchema.parse(
    await t.call(id, "platform.assets.put", {
      config: configOf([added]),
      expectedRevision: read.revision
    })
  );
  expect(saved).toEqual({ saved: true, revision: t.published + 1 });
  expect(await t.asset()).toEqual({ revision: t.published + 1, publishedRevision: t.published });
  const owner = asUserId((await t.app.call("me.get", {})).json<{ id: string }>().id);
  const runs = await t.app.stores.operationRuns.list({ clientInstanceId: t.clientInstanceId });
  const put = runs.filter((run) => run.operation === "platform.assets.put");
  expect(put).toHaveLength(1);
  expect(put[0]).toMatchObject({
    status: "done",
    actor: { kind: "user", id: owner },
    origin: { kind: "agent" }
  });
  const audited = await t.app.stores.audit.listAuditEvents({
    clientInstanceId: t.clientInstanceId
  });
  const updates = audited.filter(
    (event) =>
      event.type === "config_asset.updated" && event.metadata?.operationRunId === put[0]?.id
  );
  expect(updates).toHaveLength(1);
  expect(updates[0]?.actor?.userId).toBe(owner);
}, 120_000);
