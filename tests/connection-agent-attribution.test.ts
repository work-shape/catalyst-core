import { expect, it } from "vitest";
import { asAgentRunId, asToolCallId } from "@work-shape/catalyst-core";
import { createToolOperationRunner, ToolRegistry } from "@work-shape/catalyst-tool-execution";
import { createConnectionToolSource } from "@work-shape/catalyst-connections";
import { clientInstanceId } from "./support/access-instance";
import { fixture } from "./support/connection-operations";

it("attributes an agent's calls to its conversation workspace even when another workspace also offers the Connection (AVAIL-1)", async () => {
  const t = await fixture();
  await t.seed("crm");
  const one = await t.sharedWorkspace("First team");
  const two = await t.sharedWorkspace("Second team");
  for (const collaborationWorkspaceId of [one, two]) {
    await t.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId,
      userId: t.kai.id,
      role: "member"
    });
  }
  await t.expectOk(t.admin.id, "assets.set_availability", {
    params: { kind: "connection", name: "crm" },
    payload: { mode: "selected", collaborationWorkspaceIds: [one, two] }
  });
  t.state.agentTools.set("assistant", ["connection.crm.echo"]);
  const runTool = createToolOperationRunner(
    t.operationCalls.deps,
    new ToolRegistry({ tools: [] }),
    {
      source: createConnectionToolSource(t.sourceDeps)
    }
  );
  for (const workspaceId of [one, two]) {
    const conversation = await t.stores.conversations.createConversation({
      clientInstanceId,
      collaborationWorkspaceId: workspaceId,
      createdByUserId: t.kai.id,
      createdByExternalUserId: t.kai.id,
      visibility: "private",
      title: "Connection call",
      retainedUntil: "2099-01-01T00:00:00.000Z"
    });
    const correlationId = `connection-attribution-${workspaceId}`;
    expect(
      await runTool(
        {
          toolName: "connection.crm.echo",
          agentName: "assistant",
          conversationId: conversation.id,
          agentRunId: asAgentRunId(`run-${workspaceId}`),
          toolCallId: asToolCallId(`call-${workspaceId}`),
          input: { text: "hello" }
        },
        {
          clientInstanceId,
          correlationId,
          user: {
            id: t.kai.id,
            externalUserId: t.kai.id,
            displayLabel: t.kai.displayLabel,
            roles: t.kai.roles,
            permissionRefs: [],
            clientInstanceId,
            authSource: "test"
          }
        }
      )
    ).toMatchObject({ status: "success", output: { text: "hello" } });
    expect((await t.runs()).find((run) => run.correlationId === correlationId)).toMatchObject({
      workspaceId,
      conversationId: conversation.id,
      actor: { id: t.kai.id },
      origin: { kind: "agent", conversationId: conversation.id },
      status: "done"
    });
  }
});
