import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { WORKFLOW_ASSET_KIND } from "@work-shape/catalyst-core";
import { clientInstanceId, errorSchema, type AccessInstance } from "./support/access-instance";
import { operationOf } from "./support/connection-operations";
import { issuePersonalKey, personalKeyToken } from "./support/personal-api-keys";
import { runSchema, type WorkflowFixture } from "./support/workflow-instance";
import { NOTE, notifyClients, readyWorkflows } from "./support/workflow-runs";

// CLI-PARITY-4 review: `workflow start` is a use-level command. A key that names `workflow.use`
// starts a run by hand, narrowed by the `<action>[:<workspace>[/<asset>]]` grammar, with no
// right to write Workflows on the key; a key without it is refused with `workflow.use` named.
// Fails without the key path: the start asked `config_assets:write` of the key, so a read+use
// key was refused with "Missing auth scope 'config_assets:write'".

async function allow(t: AccessInstance, userId: string, action: string) {
  await t.stores.access.createGrant({
    clientInstanceId,
    holderKind: "user",
    holderId: userId,
    action,
    effect: "allow",
    scopeKind: "instance",
    grantedBy: t.root.id
  });
}

describe("starting a Workflow with a personal key", () => {
  let open: WorkflowFixture | undefined;
  afterEach(async () => {
    await open?.instance.close();
    open = undefined;
  });

  const ready = async () => {
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { personalKeys: true, definitions: "assets" }
    );
    const person = await t.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Tim",
      roles: ["user"],
      permissions: []
    });
    for (const action of ["workflow.read", "workflow.write", "workflow.use"]) {
      await allow(t, person.id, action);
    }
    // crm answers outside clients, so only the key decides the start.
    const exposure = ["workflow", "outside"];
    await t.seed("crm", {
      displayName: "Kundenregister",
      operations: [
        operationOf("echo", { exposure }),
        operationOf("write", { effect: "changing", exposure })
      ]
    });
    const manifest = notifyClients();
    const [trigger, ...rest] = manifest.steps;
    const definition = {
      ...manifest,
      steps: [{ ...trigger, triggers: [{ kind: "manual" }, { kind: "outside" }] }, ...rest]
    };
    const written = await t.call(t.root.id, "assets.put", {
      params: { kind: WORKFLOW_ASSET_KIND, name: definition.id },
      payload: { config: { name: definition.id, manifest: definition }, expectedRevision: null }
    });
    expect(written.statusCode, written.body).toBe(200);
    const { revision } = z.object({ revision: z.number() }).parse(written.json());
    const published = await t.call(t.root.id, "assets.publish", {
      params: { kind: WORKFLOW_ASSET_KIND, name: definition.id },
      payload: { revision }
    });
    expect(published.statusCode, published.body).toBe(200);
    return { t, person, workflow: definition.id };
  };

  const startWith = async (
    context: Awaited<ReturnType<typeof ready>>,
    scopes: string[],
    workflow = context.workflow
  ) => {
    const headers = await personalKeyToken(
      context.t,
      (await issuePersonalKey(context.t, scopes, context.person.id)).secret
    );
    return context.t.call(context.person.id, "workflows.start", {
      params: { workflow },
      payload: { input: { note: NOTE } },
      headers
    });
  };

  it("starts a run for a key with the read and use levels and no right to write", async () => {
    const context = await ready();
    const started = await startWith(context, ["workflow.read", "workflow.use"]);
    expect(started.statusCode, started.body).toBe(200);
    expect((await context.t.finish(runSchema.parse(started.json()).id)).status).toBe("done");
    // The use right alone is enough.
    const only = await startWith(context, ["workflow.use"]);
    expect(only.statusCode, only.body).toBe(200);
  });

  it("refuses a key without workflow.use, naming it, though it may read and write Workflows", async () => {
    const context = await ready();
    for (const scopes of [["workflow.read"], ["workflow.read", "workflow.write"]]) {
      const refused = await startWith(context, scopes);
      expect(refused.statusCode, refused.body).toBe(403);
      const { error } = errorSchema.parse(refused.json());
      expect(error.details).toEqual({ action: "workflow.use", reason: "outside_key_scope" });
      expect(error.message).toContain("'workflow.use'");
      expect(error.message).toContain("use level");
    }
    expect(context.t.executed).toEqual([]);
  });

  it("narrows the start to the workspace and Workflow the key names", async () => {
    const context = await ready();
    const created = await context.t.call(context.t.root.id, "workspaces.create", {
      payload: { name: "Elsewhere" }
    });
    expect(created.statusCode, created.body).toBe(200);
    const elsewhere = created.json<{ id: string }>().id;
    const refused = await startWith(context, [
      "workflow.read",
      `workflow.use:${elsewhere}/notify-clients`
    ]);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(errorSchema.parse(refused.json()).error.details).toMatchObject({
      action: "workflow.use",
      reason: "outside_key_scope"
    });
    expect(context.t.executed).toEqual([]);
  });
});
