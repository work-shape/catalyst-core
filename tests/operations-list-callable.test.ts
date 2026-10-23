import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { workflowSummarySchema } from "@work-shape/catalyst-api-contract";
import { createPlatformAssetCalls } from "@work-shape/catalyst-server";
import {
  callableOperationsPageSchema,
  asAgentRunId,
  asConversationId,
  asToolCallId,
  type ToolExecutionContext,
  type UserRecord,
  type WorkflowManifest
} from "@work-shape/catalyst-core";
import { clientInstanceId } from "./support/access-instance";
import { operationOf } from "./support/connection-operations";
import { testServerOptions } from "./support/test-instance";
import { child, ref } from "./support/workflow-children";
import { runSchema, workflowFixture, type WorkflowFixture } from "./support/workflow-instance";

// The operations a step of a Workflow may call, over HTTP for the Settings of a step
// (WF-EDIT-3, Events check 126): `operations.list_callable` and the agent's
// `platform.assets.operations` answer the same operations for the same person, with title and
// source; a person without `connection.use` on a Connection is offered none of its operations;
// a source the person may not read is named by its kind alone; each check is asked dry. The
// listing advises: the run's own call is still checked under the identity the run acts as.
// `workflows.list` says how each Workflow is started, for the child picker. Fails without
// WF-EDIT-3: there was no HTTP listing, the tool told no title or source, and the list no
// trigger.

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});

async function ready() {
  const t = await workflowFixture({ definitions: "assets" });
  open = t;
  await t.seedCrm();
  await t.seed("bookings", {
    displayName: "Exampledata",
    operations: [operationOf("echo", { exposure: ["workflow"], title: "Load the bookings" })]
  });
  t.setBehaviour(() => Promise.resolve({ clients: [] }));
  const options = testServerOptions(t.instance);
  if (!options) throw new Error("The instance has no server options");
  return { t, calls: createPlatformAssetCalls(options) };
}

const listed = async (t: WorkflowFixture, user: UserRecord, query: Record<string, string> = {}) =>
  callableOperationsPageSchema.parse(
    (await t.expectOk(user.id, "operations.list_callable", { query })).json()
  );

/** A tool call of the agent in a new conversation of `user`. */
async function contextOf(t: WorkflowFixture, user: UserRecord): Promise<ToolExecutionContext> {
  const created = await t.expectOk(user.id, "conversations.create", {
    payload: { title: "Build a Workflow" }
  });
  const { id } = z.object({ id: z.string() }).parse(created.json());
  return {
    user: {
      id: user.id,
      externalUserId: user.id,
      displayLabel: user.displayLabel,
      roles: user.roles,
      permissions: user.permissions,
      permissionRefs: user.permissionRefs,
      clientInstanceId,
      authSource: "test"
    },
    clientInstanceId,
    correlationId: `corr_${id}`,
    toolRequest: {
      toolName: "platform.assets.operations",
      toolCallId: asToolCallId(`call_${id}`),
      agentRunId: asAgentRunId(`run_${id}`),
      conversationId: asConversationId(id),
      agentName: "assistant",
      input: {}
    }
  };
}

const ofConnections = (page: z.infer<typeof callableOperationsPageSchema>) =>
  page.operations.filter(({ name }) => name.startsWith("connection."));

describe("operations.list_callable", () => {
  it("answers what the agent's tool answers, for the same person, and only what the person may call", async () => {
    const { t, calls } = await ready();
    // Kai holds nothing on a Connection: none of their operations is offered.
    expect(ofConnections(await listed(t, t.kai))).toEqual([]);
    expect(
      ofConnections(await calls.listOperations(await contextOf(t, t.kai), "workflow"))
    ).toEqual([]);

    await t.allow({ kind: "user", id: t.kai.id }, "connection.use");
    const http = await listed(t, t.kai);
    const agent = await calls.listOperations(await contextOf(t, t.kai), "workflow");
    expect(agent).toEqual(http);
    expect(ofConnections(http).map(({ name, title, effect }) => [name, title, effect])).toEqual([
      ["connection.bookings.echo", "Load the bookings", "reading"],
      ["connection.crm.echo", "echo", "reading"],
      ["connection.crm.write", "write", "changing"]
    ]);
    // Use without read: the source is named by its kind alone.
    expect(ofConnections(http).map(({ source }) => source)).toEqual([
      { kind: "connection" },
      { kind: "connection" },
      { kind: "connection" }
    ]);

    await t.allow({ kind: "user", id: t.kai.id }, "connection.read");
    const read = await listed(t, t.kai, { prefix: "connection.bookings." });
    expect(read.operations.map(({ source }) => source)).toEqual([
      { kind: "connection", title: "Exampledata" }
    ]);
    expect(
      await calls.listOperations(await contextOf(t, t.kai), "workflow", {
        prefix: "connection.bookings."
      })
    ).toEqual(read);
  });

  it("lists for a Workflow's step only: an App's listing is the agent's", async () => {
    const { t } = await ready();
    const response = await t.call(t.root.id, "operations.list_callable", {
      query: { for: "app" }
    });
    expect(response.statusCode).toBe(422);
  });

  it("asks each operation's check dry: a refused one writes no audit event", async () => {
    const { t } = await ready();
    const before = await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 500 });
    expect(ofConnections(await listed(t, t.kai))).toEqual([]);
    const after = await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 500 });
    expect(after.length).toBe(before.length);
  });

  it("advises and grants nothing: the run's call is checked under the identity it acts as", async () => {
    const { t } = await ready();
    await t.allow({ kind: "user", id: t.kai.id }, "connection.use");
    expect(
      (await listed(t, t.kai, { name: "connection.crm.echo" })).operations.map(({ name }) => name)
    ).toEqual(["connection.crm.echo"]);
    // The Workflow's account holds no `connection.use`: the step is refused when it runs.
    const manifest: WorkflowManifest = {
      id: "read-crm",
      name: "Read the CRM",
      runAs: "workflow-runner",
      inputs: { type: "object" },
      outputs: { type: "object" },
      steps: [
        { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
        {
          id: "read",
          name: "Read",
          type: "operation",
          operation: "connection.crm.echo",
          input: { text: { value: "all" } }
        },
        { id: "result", name: "Result", type: "output", input: { clients: ref("read", "clients") } }
      ]
    };
    await t.expectOk(t.root.id, "assets.put", {
      params: { kind: "workflow", name: manifest.id },
      payload: { expectedRevision: null, config: { name: manifest.id, manifest } }
    });
    await t.expectOk(t.root.id, "assets.publish", {
      params: { kind: "workflow", name: manifest.id },
      payload: { revision: 1 }
    });
    const started = runSchema.parse(
      (
        await t.expectOk(t.root.id, "workflows.start", {
          params: { workflow: manifest.id },
          payload: { input: {} }
        })
      ).json()
    );
    const ended = await t.finish(started.id);
    expect(ended.status).toBe("failed");
    expect(ended.error).toMatchObject({ action: "connection.use" });
  });
});

describe("workflows.list for the child picker", () => {
  it("says how each published Workflow is started", async () => {
    const { t } = await ready();
    await t.expectOk(t.root.id, "assets.put", {
      params: { kind: "workflow", name: "child" },
      payload: { expectedRevision: null, config: { name: "child", manifest: child() } }
    });
    await t.expectOk(t.root.id, "assets.publish", {
      params: { kind: "workflow", name: "child" },
      payload: { revision: 1 }
    });
    const page = z
      .object({ items: z.array(workflowSummarySchema) })
      .parse((await t.expectOk(t.root.id, "workflows.list", { query: {} })).json());
    expect(page.items.map(({ id, triggers }) => [id, triggers])).toEqual([["child", ["parent"]]]);
  });
});

describe("operations.list_callable and mail.send (MAIL-3)", () => {
  const names = async (t: WorkflowFixture, user: UserRecord) =>
    (await listed(t, user, { prefix: "mail." })).operations.map(({ name }) => name);

  it("offers a step mail.send where the instance has it, to whom may send as a sender", async () => {
    const off = await workflowFixture({ definitions: "assets" });
    open = off;
    expect(await names(off, off.root)).toEqual([]);
    await off.instance.close();

    const t = await workflowFixture({ definitions: "assets", mail: { recipientDomains: [] } });
    open = t;
    expect(await names(t, t.root)).toEqual(["mail.send"]);
    // Kai holds mail_sender.use on no sender: the palette offers no e-mail step.
    expect(await names(t, t.kai)).toEqual([]);
  });
});
