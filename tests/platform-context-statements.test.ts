import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { platformContextSchema } from "@vivd-catalyst/api-contract";
import { setupConnectionInstance } from "./support/connections";

// The statements of one request, as `chat-server-conversation-list-statements.test.ts` counts
// them: the instance sends statements of its own on the same pool, so only what is sent from
// inside the counted request is counted.
const counted = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return new AsyncLocalStorage<string[]>();
});

vi.mock("postgres", async (importOriginal) => {
  type Connect = (url: string, options?: postgres.Options<Record<string, never>>) => postgres.Sql;
  const actual = await importOriginal<{ default: Connect }>();
  const connect: Connect = (url, options) =>
    actual.default(url, {
      ...options,
      debug: (_connection, statement) => {
        counted.getStore()?.push(statement);
      }
    });
  return { ...actual, default: Object.assign(connect, actual.default) };
});

describe("platform.context.get statements", () => {
  // Fails without the change: the read grants on single assets were read with a second load of
  // the holder's status and grant rows, two statements more on every signed-in person's request.
  it("reads the caller's grant rows once, with grants on single assets or with none", async () => {
    const t = await setupConnectionInstance();
    const a = await t.seed("alpha");
    await t.createNamespace("kai-");
    await t.grant(t.kai.id, "agent.read", { namespace: "kai-" });
    await t.grant(t.kai.id, "connection.read", { assetId: a });
    await t.grant(t.kai.id, "connection.use", { assetId: a });

    /** What the request sent, without the type lookup of a connection the pool just opened. */
    const statementsOf = async (userId: string) => {
      const sent: string[] = [];
      const response = await counted.run(sent, () => t.expectOk(userId, "platform.context.get"));
      const statements = sent.filter((statement) => !statement.includes("pg_catalog.pg_type"));
      return {
        context: platformContextSchema.parse(response.json()),
        count: statements.length,
        grantReads: statements.filter((statement) => statement.includes('"permission_grants"'))
          .length
      };
    };
    // The first request opens connections; the counted ones find them open.
    await statementsOf(t.lena.id);

    const without = await statementsOf(t.lena.id);
    expect(without.context.assetActions).toEqual([]);
    expect(without.grantReads).toBe(1);

    const withGrants = await statementsOf(t.kai.id);
    expect(withGrants.context.assetActions).toEqual(["connection.read"]);
    expect(withGrants.grantReads).toBe(1);
    expect(withGrants.count).toBe(without.count);
    // Authentication, authorization's one load of the holder and the grant rows, the
    // Namespace records, and the Shared Workspaces and the caller's own, whose rights the
    // context names (WS-OWN-1a).
    expect(withGrants.count).toBe(CONTEXT_STATEMENTS);
  });
});

/**
 * What `platform.context.get` sent before it named `assetActions`: the test sign-in reads the
 * person's record in one statement, as the evaluator reads the rights from the rows (AP-4).
 */
const CONTEXT_STATEMENTS = 6;
