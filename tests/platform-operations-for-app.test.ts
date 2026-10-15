import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createPlatformAssetCalls } from "@work-shape/catalyst-server";
import {
  asAgentRunId,
  asConversationId,
  asToolCallId,
  type ToolExecutionContext,
  type UserRecord
} from "@work-shape/catalyst-core";
import { clientInstanceId } from "./support/access-instance";
import { setupAppActions, type AppActionsInstance } from "./support/app-actions";
import { operationOf } from "./support/connection-operations";
import { testServerOptions } from "./support/test-instance";

// The operations the agent may name, by who calls them: `platform.assets.operations` answered
// those a step of a Workflow may call, and only in a conversation about an asset. An agent that
// writes an App's `connection` action needs those an App may call, while it builds a Page of a
// conversation about nothing. Fails without the change: the list took no audience, so an
// operation exposed to Apps alone was never listed, and a conversation without a subject was
// refused.

describe("the operations the agent may name", () => {
  let t: AppActionsInstance;
  let calls: ReturnType<typeof createPlatformAssetCalls>;

  beforeAll(async () => {
    t = await setupAppActions();
    // `crm` offers `echo` to Apps and agents and `write` to Apps, `erp` both to agents only,
    // `hidden` `echo` to Apps; this one offers `echo` to Workflows only.
    await t.seed("books", { operations: [operationOf("echo", { exposure: ["workflow"] })] });
    await t.grant(t.admin.id, "connection.use", {
      assetId: await t.assetId("connection", "books")
    });
    await t.instance.call("health.get");
    const options = testServerOptions(t.instance);
    if (!options) throw new Error("The instance has no server options");
    calls = createPlatformAssetCalls(options);
  });
  afterAll(() => t.closeAll());

  /** A tool call of the agent in a new conversation of `user`, which is about nothing. */
  async function contextOf(user: UserRecord): Promise<ToolExecutionContext> {
    const created = await t.expectOk(user.id, "conversations.create", {
      payload: { title: "Dashboard" }
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
      correlationId: `corr_${randomUUID()}`,
      toolRequest: {
        toolName: "platform.assets.operations",
        toolCallId: asToolCallId(`call_${randomUUID()}`),
        agentRunId: asAgentRunId(`run_${randomUUID()}`),
        conversationId: asConversationId(id),
        agentName: "assistant",
        input: {}
      }
    };
  }

  const names = async (user: UserRecord, audience: "app" | "workflow") =>
    (await calls.listOperations(await contextOf(user), audience)).operations.map(
      ({ name, effect }) => `${name} ${effect}`
    );

  it("are for an App those of Connections exposed to Apps, and for a Workflow those exposed to Workflows", async () => {
    expect(await names(t.admin, "app")).toEqual([
      "connection.crm.echo reading",
      "connection.crm.write changing",
      "connection.hidden.echo reading"
    ]);
    expect(await names(t.admin, "workflow")).toEqual(["connection.books.echo reading"]);
  });

  it("are none of a Connection the person may not use", async () => {
    expect(await names(t.kai, "app")).toEqual([]);
  });
});
