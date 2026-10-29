import { describe, expect, it } from "vitest";
import { z } from "zod";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import {
  PERSONAL_API_KEY_ACTIONS,
  PERSONAL_API_KEY_ROW_USE_OPERATIONS,
  operationScopesOfPersonalApiKey
} from "@work-shape/catalyst-core";
import { errorSchema } from "./support/access-instance";
import {
  finding,
  useDataStoreInstance,
  type DataStoreInstance
} from "./support/data-store-instance";

// CLI-PARITY-4: the use level of a personal key reaches four row operations and no other. The
// key carries `data_store_rows:use` for them when it names a use right of rows; each still asks
// its own right of the key and of the person. Fails without the level: the key is refused with
// the missing right named, and no operation under `data_store_rows:*` beside the four opens.

const STORE = "findings";
const READ = "data_store.read";
const INSERT = "data_store.insert";

const rowsSchema = z.object({ rows: z.array(z.unknown()) });
const querySchema = z.object({ rows: z.array(z.record(z.string(), z.unknown())) });
const insertedSchema = z.object({ inserted: z.number() });

describe("the use level of a personal key on rows", () => {
  const { start, publishStore } = useDataStoreInstance();

  async function setup() {
    const world = await start(true, undefined, undefined, undefined, { apiAccess: true });
    await publishStore(world);
    const seeded = await world.api.call("data_stores.insert", {
      params: { store: STORE },
      payload: { table: STORE, rows: [finding] }
    });
    expect(seeded.statusCode, seeded.body).toBe(200);
    return world;
  }

  /** A key of the person as the instance's administrator, and its access token. */
  async function keyHeaders(world: DataStoreInstance, scopes: string[]) {
    const issued = await world.api.call("me.api_keys.create", {
      payload: {
        name: "CLI",
        scopes,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString()
      }
    });
    expect(issued.statusCode, issued.body).toBe(200);
    const exchanged = await world.api.call("access_tokens.exchange", {
      headers: { authorization: `Bearer ${issued.json<{ secret: string }>().secret}` }
    });
    expect(exchanged.statusCode, exchanged.body).toBe(200);
    return { authorization: `Bearer ${exchanged.json<{ accessToken: string }>().accessToken}` };
  }

  const rows = (world: DataStoreInstance, headers: Record<string, string>) =>
    world.api.call("data_stores.rows", {
      params: { store: STORE },
      query: { table: STORE },
      headers
    });
  const query = (world: DataStoreInstance, headers: Record<string, string>) =>
    world.api.call("data_stores.query", {
      params: { store: STORE },
      payload: { sql: "select rule_id from findings" },
      headers
    });
  const insert = (world: DataStoreInstance, headers: Record<string, string>) =>
    world.api.call("data_stores.insert", {
      params: { store: STORE },
      payload: { table: STORE, rows: [{ ...finding, run_id: "run-2" }] },
      headers
    });

  it("maps the scope to the use rights of rows and to no other right", () => {
    for (const action of PERSONAL_API_KEY_ACTIONS) {
      const scopes = operationScopesOfPersonalApiKey([action]);
      expect(scopes.includes("data_store_rows:use"), action).toBe(
        [INSERT, "data_store.execute", "knowledge_base.use"].includes(action)
      );
      // Never the scopes of rows that the other operations ask.
      expect(scopes).not.toContain("data_store_rows:read");
      expect(scopes).not.toContain("data_store_rows:write");
    }
    expect(Object.keys(PERSONAL_API_KEY_ROW_USE_OPERATIONS).sort()).toEqual(
      Object.values(apiOperations)
        .filter((operation) => "personalKeyScope" in operation)
        .filter((operation) => operation.personalKeyScope === "data_store_rows:use")
        .map((operation) => operation.id)
        .sort()
    );
  });

  it("refuses a key without the use level on each row command, naming the right", async () => {
    const world = await setup();
    // The read level and the rights of authoring, and no use right.
    const headers = await keyHeaders(world, [READ, "data_store.write", "knowledge_base.read"]);
    const refused = [
      [await rows(world, headers), "data_store.read"],
      [await query(world, headers), "data_store.read"],
      [await insert(world, headers), "data_store.insert"],
      [
        await world.api.call("knowledge_bases.query", {
          params: { knowledgeBase: "accounts" },
          payload: { sql: "select 1" },
          headers
        }),
        "knowledge_base.use"
      ]
    ] as const;
    const messages: string[] = [];
    for (const [response, right] of refused) {
      expect(response.statusCode, response.body).toBe(403);
      const { error } = errorSchema.parse(response.json());
      expect(error.details).toEqual({ action: right, reason: "outside_key_scope" });
      expect(error.message).toContain(`'${right}'`);
      expect(error.message).toContain("use level");
      messages.push(error.message);
      expect(response.body).not.toContain("client-secret-7");
    }
    // The words the CLI prints, as the CLI tests of the refusals hold them.
    expect(messages).toEqual([
      "The API key of this call does not carry the use level, which 'data_stores.rows' needs: its scopes must name 'data_store.read' and one of 'data_store.insert', 'data_store.execute', 'knowledge_base.use'. Use a key with the use level (Verwenden)",
      "The API key of this call does not carry the use level, which 'data_stores.query' needs: its scopes must name 'data_store.read' and one of 'data_store.insert', 'data_store.execute', 'knowledge_base.use'. Use a key with the use level (Verwenden)",
      "The API key of this call does not carry the use level, which 'data_stores.insert' needs: its scopes must name 'data_store.insert'. Use a key with the use level (Verwenden)",
      "The API key of this call does not carry the use level, which 'knowledge_bases.query' needs: its scopes must name 'knowledge_base.use'. Use a key with the use level (Verwenden)"
    ]);
  });

  it("answers a key with the use level: rows, a query and an insert, each with its own right", async () => {
    const world = await setup();
    const headers = await keyHeaders(world, [READ, INSERT]);
    const page = await rows(world, headers);
    expect(page.statusCode, page.body).toBe(200);
    expect(rowsSchema.parse(page.json()).rows).toHaveLength(1);
    const selected = await query(world, headers);
    expect(selected.statusCode, selected.body).toBe(200);
    expect(querySchema.parse(selected.json()).rows).toEqual([{ rule_id: "vat-rate" }]);
    const added = await insert(world, headers);
    expect(added.statusCode, added.body).toBe(200);
    expect(insertedSchema.parse(added.json()).inserted).toBe(1);
    // A Knowledge Base query passes the scope with `knowledge_base.use`; this instance has no
    // such Knowledge Base, so it ends at the lookup and not at the key.
    const unknown = await world.api.call("knowledge_bases.query", {
      params: { knowledgeBase: "accounts" },
      payload: { sql: "select 1" },
      headers: await keyHeaders(world, ["knowledge_base.use"])
    });
    expect(unknown.statusCode, unknown.body).toBe(404);
  });

  it("still asks each right of the key: the level alone does not read, and reading does not insert", async () => {
    const world = await setup();
    const withoutRead = await keyHeaders(world, [INSERT]);
    for (const response of [await rows(world, withoutRead), await query(world, withoutRead)]) {
      expect(response.statusCode, response.body).toBe(403);
      expect(errorSchema.parse(response.json()).error.message).toContain(READ);
    }
    const withoutInsert = await keyHeaders(world, [READ, "knowledge_base.use"]);
    expect((await rows(world, withoutInsert)).statusCode).toBe(200);
    const refused = await insert(world, withoutInsert);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(errorSchema.parse(refused.json()).error.message).toContain(INSERT);
  });

  it("opens no other operation under the rows scopes: update, delete, preview and flagged stay closed", async () => {
    const world = await setup();
    const headers = await keyHeaders(world, [
      READ,
      INSERT,
      "data_store.execute",
      "data_store.records",
      "knowledge_base.use"
    ]);
    const refused = [
      await world.api.call("data_stores.update", {
        params: { store: STORE },
        payload: { table: STORE, rows: [{ key: { run_id: "run-1" }, set: { severity: "info" } }] },
        headers
      }),
      await world.api.call("data_stores.delete_rows", {
        params: { store: STORE },
        payload: { table: STORE, keys: [{ run_id: "run-1" }] },
        headers
      }),
      await world.api.call("data_stores.preview_rows", {
        params: { store: STORE },
        query: { table: STORE },
        headers
      }),
      await world.api.call("data_stores.records_flagged", { params: { store: STORE }, headers }),
      await world.api.call("data_stores.value", {
        params: { store: STORE },
        query: { table: STORE, column: "details", at: "x" },
        headers
      })
    ];
    for (const response of refused) {
      expect(response.statusCode, response.body).toBe(403);
      expect(errorSchema.parse(response.json()).error.message).toContain("data_store_rows");
    }
    // Reading the one row is still possible through the operation that is reached.
    expect(
      await world.api
        .call("data_stores.query", {
          params: { store: STORE },
          payload: { sql: "select severity from findings" },
          headers
        })
        .then((response) => querySchema.parse(response.json()).rows)
    ).toEqual([{ severity: "warning" }]);
  });
});
