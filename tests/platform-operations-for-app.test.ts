import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createPlatformAssetTools } from "@work-shape/catalyst-tool-execution";
import { createPlatformAssetCalls } from "@work-shape/catalyst-server";
import {
  asAgentRunId,
  asConversationId,
  asToolCallId,
  type ToolExecutionContext,
  type OperationDefinition,
  type UserRecord
} from "@work-shape/catalyst-core";
import { clientInstanceId } from "./support/access-instance";
import { appSource, setupAppActions, type AppActionsInstance } from "./support/app-actions";
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

  it("resolves incomplete resources for both the list and a Page action's right", async () => {
    const operation: OperationDefinition = {
      name: "connection.identity.echo",
      effect: "reading",
      action: "connection.use",
      scope: null,
      auth: "user",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      resource: () => ({ kind: "connection", id: "crm", name: "crm" }),
      timeoutMs: 1000,
      execute: () => Promise.resolve({})
    };
    t.operationCalls.registry.addSource({
      resolve: (name) => Promise.resolve(name === operation.name ? operation : undefined),
      list: () => Promise.resolve({ operations: [operation], truncated: [] })
    });
    const grant = await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: t.kai.id,
      action: "connection.use",
      effect: "allow",
      scopeKind: "instance",
      grantedBy: t.admin.id
    });
    const frame = await t.openPage(
      t.kai.id,
      appSource("identity").map((file) =>
        "text" in file
          ? {
              ...file,
              text: file.text
                .replaceAll('"crm"', '"identity"')
                .replaceAll("connection: crm", "connection: identity")
            }
          : file
      )
    );
    expect(await names(t.kai, "app")).toContain(`${operation.name} reading`);
    expect(await t.can(t.kai.id, frame)).toMatchObject({ load: "allow" });
    const deny = await t.grant(t.kai.id, "connection.use", { assetId: t.crm }, "deny");
    expect(await names(t.kai, "app")).not.toContain(`${operation.name} reading`);
    expect(await t.can(t.kai.id, frame)).toMatchObject({ load: "deny" });
    await t.stores.access.deleteGrant({ clientInstanceId, grantId: deny });
    await t.stores.access.deleteGrant({ clientInstanceId, grantId: grant.id });
  });

  describe("agent-facing operation pages beyond 200", () => {
    const expected = [
      ...Array.from(
        { length: 200 },
        (_, index) => `connection.paging.read-${String(index).padStart(3, "0")}`
      ),
      "connection.zzz.echo"
    ];
    const pageSchema = z.object({
      operations: z.array(
        z.object({ name: z.string(), inputSchema: z.object({ type: z.string() }).optional() })
      ),
      nextCursor: z.string().optional(),
      truncated: z.boolean()
    });
    const tool = () => {
      const found = createPlatformAssetTools(calls).find(
        ({ name }) => name === "platform.assets.operations"
      );
      if (!found) throw new Error("Callable-operation tool is missing");
      return found;
    };
    const page = async (user: UserRecord, input: unknown = {}) => {
      const found = tool();
      const result = await found.execute(found.inputSchema.parse(input), await contextOf(user));
      if (result.status !== "success") throw new Error("Callable-operation discovery failed");
      return pageSchema.parse(result.output);
    };

    beforeAll(async () => {
      const erp = await t.assetId("connection", "erp");
      const operation = (name: string, assetId: string): OperationDefinition => ({
        name,
        effect: "reading",
        action: "connection.use",
        scope: null,
        auth: "user",
        inputSchema: z.object({ text: z.string() }),
        outputSchema: z.object({}),
        resource: () => ({ kind: "connection", id: assetId, assetId }),
        timeoutMs: 1000,
        execute: () => Promise.resolve({})
      });
      const operations = [
        ...expected.map((name) => operation(name, t.crm)),
        // Hidden entries before, between and after visible entries cannot consume a page or its cursor.
        ...expected.map((name) => operation(`${name}-hidden`, erp))
      ];
      t.operationCalls.registry.addSource({
        resolve: async (name) => operations.find((entry) => entry.name === name),
        list: async () => ({ operations, truncated: [] })
      });
      await t.grant(t.kai.id, "connection.use", { assetId: t.crm });
    });

    it("reaches the 201st authorized operation through the tool cursor, without hidden entries on any page", async () => {
      const found: string[] = [];
      let cursor: string | undefined;
      const sizes: number[] = [];
      do {
        const listed = await page(t.kai, { for: "app", cursor });
        sizes.push(listed.operations.length);
        expect(listed.operations.length).toBeLessThanOrEqual(200);
        expect(listed.operations.every(({ name }) => !name.endsWith("-hidden"))).toBe(true);
        expect(listed.truncated).toBe(!!listed.nextCursor);
        found.push(...listed.operations.map(({ name }) => name));
        cursor = listed.nextCursor;
        if (cursor) expect(Buffer.from(cursor, "base64url").toString()).not.toContain("-hidden");
        expect(sizes.length).toBeLessThanOrEqual(2);
      } while (cursor);
      // CRM's two existing operations come first; the 201st fixture operation is on the next page.
      expect(found.filter((name) => expected.includes(name))).toEqual(expected);
      expect(sizes[0]).toBe(200);
      expect(sizes).toHaveLength(2);
    });

    it("finds the 201st operation directly by exact name or Connection prefix, and still checks rights", async () => {
      for (const filter of [{ name: "connection.zzz.echo" }, { prefix: "connection.zzz." }]) {
        const listed = await page(t.kai, { for: "app", ...filter });
        expect(listed.operations.map(({ name }) => name)).toEqual(["connection.zzz.echo"]);
        expect(listed.nextCursor).toBeUndefined();
      }
      expect((await page(t.kai, { name: "connection.zzz.echo-hidden" })).operations).toEqual([]);
      expect((await page(t.kai, { prefix: "connection.missing." })).operations).toEqual([]);
    });

    it("refuses malformed cursors and cursors from another filter or audience", async () => {
      const first = await page(t.kai, { for: "app", prefix: "connection." });
      expect(first.nextCursor).toBeDefined();
      for (const input of [
        { cursor: "invalid" },
        { for: "app", cursor: first.nextCursor },
        { for: "app", prefix: "connection.zzz.", cursor: first.nextCursor },
        { for: "workflow", prefix: "connection.", cursor: first.nextCursor }
      ]) {
        await expect(page(t.kai, input)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      }
      expect(tool().inputSchema.safeParse({ cursor: "" }).success).toBe(false);
      expect(tool().inputSchema.safeParse({ name: "" }).success).toBe(false);
      expect(tool().inputSchema.safeParse({ prefix: "" }).success).toBe(false);
    });
  });
});
