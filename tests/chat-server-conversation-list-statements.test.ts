import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import {
  createPlatformId,
  type Conversation,
  type ConversationListItem
} from "@vivd-catalyst/core";
import { createTestConfig, personalConversationListInput } from "./support/fixtures";
import { createTestInstance } from "./support/test-instance";

const sent = vi.hoisted((): string[] => []);

// Every statement a connection of this file sends to Postgres, as the driver reports it.
vi.mock("postgres", async (importOriginal) => {
  type Connect = (url: string, options?: postgres.Options<Record<string, never>>) => postgres.Sql;
  const actual = await importOriginal<{ default: Connect }>();
  const connect: Connect = (url, options) =>
    actual.default(url, {
      ...options,
      debug: (_connection, statement) => {
        sent.push(statement);
      }
    });
  return { ...actual, default: Object.assign(connect, actual.default) };
});

describe("conversation list statements", () => {
  // Fails without the change: one statement per listed conversation read its active run, so 50
  // conversations took 53 statements and 5 took 8.
  it("lists a page in at most three statements, however many conversations it holds", async () => {
    const app = await createTestInstance({ config: createTestConfig(), env: {}, tools: [] });
    const list = await personalConversationListInput(app);
    let run: { id: string } | undefined;
    for (let index = 0; index < 50; index++) {
      const created = await app.call("conversations.create", { payload: { title: `c${index}` } });
      const conversation = created.json<Conversation>();
      const message = await app.stores.conversations.appendMessage({
        clientInstanceId: conversation.clientInstanceId,
        conversationId: conversation.id,
        role: "user",
        text: "A message, so that the conversation is listed"
      });
      // One conversation of the page has an active run.
      if (index === 49) {
        run = await app.stores.agentRuns.createAgentRun({
          id: createPlatformId<"AgentRunId">("run"),
          clientInstanceId: conversation.clientInstanceId,
          conversationId: conversation.id,
          ownerUserId: conversation.createdByUserId,
          inputMessageId: message.id,
          agentName: "test_agent",
          correlationId: "corr_list_statements"
        });
      }
    }

    /** What the request sent, without the type lookup of a connection the pool just opened. */
    const statementsOf = async (query: NonNullable<typeof list.query>) => {
      sent.length = 0;
      const response = await app.call("conversations.list", { ...list, query });
      return {
        response,
        count: sent.filter((statement) => !statement.includes("pg_catalog.pg_type")).length
      };
    };
    // The route refuses an empty workspace id after the caller is known and before it lists:
    // what this request sends is what every request sends to authenticate.
    const refused = await statementsOf({ collaborationWorkspaceId: "" });
    expect(refused.response.statusCode).toBe(400);
    // The count is of real statements: authenticating sends some.
    expect(refused.count).toBeGreaterThan(0);

    const fifty = await statementsOf({ ...list.query });
    expect(fifty.response.statusCode).toBe(200);
    const items = fifty.response.json<{ items: ConversationListItem[] }>().items;
    expect(items).toHaveLength(50);
    expect(items.filter((item) => item.activeRun).map((item) => item.activeRun?.id)).toEqual([
      run?.id
    ]);
    expect(fifty.count).toBeGreaterThan(refused.count);
    expect(fifty.count - refused.count).toBeLessThanOrEqual(3);

    const five = await statementsOf({ ...list.query, limit: "5" });
    expect(five.response.json<{ items: ConversationListItem[] }>().items).toHaveLength(5);
    expect(five.count).toBe(fifty.count);
  });
});
