import { describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { writeFile } from "node:fs/promises";
import {
  asAgentRunId,
  asConversationId,
  type AgentRun,
  type JsonObject
} from "@work-shape/catalyst-core";
import { clientInstanceId, useDataStoreInstance } from "./support/data-store-instance";
import { injectStartConversationRun } from "./support/chat-server-run-harness";
import { required } from "./support/assertions";
import { getTestJobs } from "./support/test-instance";
import { fileTestDatabaseUrl } from "./support/test-database";
import { recordsLiveCliModel, RECORDS_LIVE_MODEL_PROVIDER } from "./support/records-live-cli-model";

/** A complete natural-language turn may need several live model/tool exchanges. */
const LIVE_TURN_WAIT_MS = 300_000;
/** Bounds a mistaken model's repeated write requests in this synthetic journey. */
const LIVE_WRITE_CONFIRMATIONS_MAX = 10;
const definitionSchema = (value: unknown) => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("migrations" in value) ||
    !Array.isArray(value.migrations)
  )
    throw new Error("No Data Store draft definition");
  return value.migrations.map((migration: unknown) => {
    if (
      typeof migration !== "object" ||
      migration === null ||
      !("sql" in migration) ||
      typeof migration.sql !== "string"
    )
      throw new Error("No migration SQL");
    return migration.sql;
  });
};

describe("check 105: real-model rows from chat", () => {
  const { startWithAgent } = useDataStoreInstance();
  it.each(["en", "de"] as const)(
    "keeps, changes and finds Alex after publication and confirmations in %s",
    async (locale) => {
      const live = recordsLiveCliModel();
      const world = await startWithAgent({
        capability: live.capability,
        provider: RECORDS_LIVE_MODEL_PROVIDER,
        locale
      });
      const created = await world.api.call("conversations.create", {
        payload: { title: "Synthetic holiday requests" }
      });
      expect(created.statusCode, created.body).toBe(200);
      const conversationId = created.json<{ id: string }>().id;
      const transcript: unknown[] = [];
      async function settled(runId: string) {
        let run: AgentRun | undefined;
        await vi.waitFor(
          async () => {
            run = await world.stores.agentRuns.getAgentRun({
              clientInstanceId,
              runId: asAgentRunId(runId)
            });
            expect(["completed", "waiting_for_decision", "failed", "cancelled"]).toContain(
              run?.status
            );
          },
          { timeout: LIVE_TURN_WAIT_MS, interval: 100 }
        );
        const result = required(run);
        expect(result.status, JSON.stringify(result.error)).not.toBe("failed");
        return result;
      }
      async function say(id: string, text: string) {
        transcript.push({ user: text });
        const said = await injectStartConversationRun(world.api, id, text);
        return settled(said.run.id);
      }
      async function reply(id: string, run: AgentRun) {
        const messages = await world.stores.conversations.listMessages({
          clientInstanceId,
          conversationId: asConversationId(id)
        });
        transcript.push(...messages);
        transcript.push({ completedRun: run.id });
        return messages.filter((message) => message.role === "assistant").at(-1)?.text ?? "";
      }
      const first = await say(
        conversationId,
        locale === "de"
          ? "Lege eine Tabelle mit erfundenen Urlaubsanträgen an. Füge einen Antrag von Alex vom 2. bis 6. November ein, ändere das Ende auf den 5. November und finde Alex wieder."
          : "Create a table of made-up holiday requests. Add a request from Alex for 2 to 6 November, change the end to 5 November, then find Alex again."
      );
      expect(first.status).toBe("completed");
      expect(await reply(conversationId, first)).toMatch(
        locale === "de"
          ? /(?:kein[^.]*gespeichert|nicht[^.]*gespeichert|noch keine|noch nicht eingetragen|Tabelle ist leer)/iu
          : /(?:no|nothing|not|haven['’]t|hasn['’]t)[^.]*\b(?:stored|saved|inserted|added)\b/iu
      );
      const subject = required(
        (
          await world.stores.conversations.getConversation(
            clientInstanceId,
            asConversationId(conversationId)
          )
        )?.subject
      );
      expect(subject.kind).toBe("data_store");
      const asset = required(
        await world.stores.configAssets.getConfigAsset({
          clientInstanceId,
          kind: "data_store",
          name: subject.name
        })
      );
      expect(asset.publishedRevisionId).toBeUndefined();
      const migrations = definitionSchema(asset.config);
      expect(migrations.join("\n")).not.toMatch(/\b(?:insert|update|delete|copy)\b/iu);
      expect(migrations.join("\n")).toMatch(/primary\s+key/iu);
      expect(
        await world.stores.dataStores.findDataStoreByName({ clientInstanceId, name: subject.name })
      ).toBeUndefined();
      const published = await world.api.call("assets.publish", {
        params: { kind: "data_store", name: subject.name },
        payload: {
          revision: asset.revision,
          ...(asset.scope.kind === "workspace" ? { workspaceId: asset.scope.workspaceId } : {})
        }
      });
      expect(published.statusCode, published.body).toBe(200);
      let database: string | undefined;
      await vi.waitFor(
        async () => {
          await getTestJobs(world.api).runDue();
          const store = await world.stores.dataStores.findDataStoreByName({
            clientInstanceId,
            name: subject.name
          });
          expect(store).toMatchObject({ status: "ready", level: migrations.length });
          database = store?.location.database;
        },
        { timeout: 30_000, interval: 100 }
      );
      const url = new URL(await fileTestDatabaseUrl());
      url.pathname = `/${required(database)}`;
      const sql = postgres(url.toString(), { max: 1 });
      const tables = await sql<
        { name: string }[]
      >`select tablename as name from pg_tables where schemaname = 'public' order by tablename`;
      const snapshot = async (): Promise<JsonObject[]> => {
        const all: JsonObject[] = [];
        for (const table of tables) {
          const name = '"' + table.name.replaceAll('"', '""') + '"';
          const rows = await sql.unsafe<{ row: JsonObject }[]>(
            `select to_jsonb(t) as row from public.${name} t`
          );
          all.push(...rows.map(({ row }) => row));
        }
        return all;
      };
      const alexRows = (rows: JsonObject[]) =>
        rows.filter((row) => Object.values(row).some((value) => value === "Alex"));
      const textOf = (rows: JsonObject[]) => JSON.stringify(rows);
      try {
        expect(await snapshot()).toEqual([]);
        let turn = await say(conversationId, locale === "de" ? "weiter" : "continue");
        const confirmed: string[] = [];
        for (
          let n = 0;
          turn.status === "waiting_for_decision" && n < LIVE_WRITE_CONFIRMATIONS_MAX;
          n += 1
        ) {
          const held = required(
            (await world.stores.operationRuns.list({ clientInstanceId })).find(
              (run) =>
                run.origin.kind === "agent" &&
                run.origin.agentRunId === turn.id &&
                run.status === "pending_confirmation" &&
                !run.decision
            )
          );
          expect(held.operation).toMatch(/\.(?:insert|update)$/u);
          if (held.operation.endsWith(".insert")) expect(alexRows(await snapshot())).toEqual([]);
          if (held.operation.endsWith(".update"))
            expect(textOf(alexRows(await snapshot()))).toContain("11-06");
          confirmed.push(held.operation);
          const answered = await world.api.call("operations.decide", {
            params: { runId: held.id },
            payload: { decision: "confirm" }
          });
          expect(answered.statusCode, answered.body).toBe(200);
          turn = await settled(turn.id);
        }
        expect(turn.status).toBe("completed");
        const alex = alexRows(await snapshot());
        // Mutation 1 must fail at the database, regardless of what the model says.
        expect(alex).toHaveLength(1);
        expect(textOf(alex)).toContain("11-05");
        expect(textOf(alex)).not.toContain("11-06");
        expect(confirmed.some((name) => name.endsWith(".insert"))).toBe(true);
        expect(confirmed.some((name) => name.endsWith(".update"))).toBe(true);
        await reply(conversationId, turn);
        const readOps = (await world.stores.operationRuns.list({ clientInstanceId })).filter(
          (run) =>
            run.origin.kind === "agent" &&
            run.origin.agentRunId === turn.id &&
            run.operation.endsWith(".query") &&
            run.status === "done"
        );
        expect(readOps.length).toBeGreaterThan(0);
        const fresh = await world.api.call("conversations.create", {
          payload: { title: "Read Alex", subject }
        });
        const freshId = fresh.json<{ id: string }>().id;
        const found = await say(
          freshId,
          locale === "de"
            ? "Finde Alex und nenne das Ende des Urlaubsantrags."
            : "Find Alex and tell me the end of the holiday request."
        );
        expect(found.status).toBe("completed");
        expect(await reply(freshId, found)).toMatch(/5|05|fifth/iu);
        expect(alexRows(await snapshot())).toEqual(alex);
        const declining = await say(
          conversationId,
          locale === "de"
            ? "Ändere das Ende von Alex' Antrag auf den 4. November."
            : "Change the end of Alex's request to 4 November."
        );
        expect(declining.status).toBe("waiting_for_decision");
        const held = required(
          (await world.stores.operationRuns.list({ clientInstanceId })).find(
            (run) =>
              run.origin.kind === "agent" &&
              run.origin.agentRunId === declining.id &&
              run.status === "pending_confirmation"
          )
        );
        expect(alexRows(await snapshot())).toEqual(alex);
        expect(
          (
            await world.api.call("operations.decide", {
              params: { runId: held.id },
              payload: { decision: "decline" }
            })
          ).statusCode
        ).toBe(200);
        const declined = await settled(declining.id);
        expect(declined.status).toBe("completed");
        expect(alexRows(await snapshot())).toEqual(alex);
        expect(await reply(conversationId, declined)).toMatch(
          locale === "de"
            ? /(?:nicht|unverändert|abgelehnt|bleibt|beibehalten)/iu
            : /(?:not|unchanged|declined|denied|kept|left)/iu
        );
        const unbound = await world.api.call("conversations.create", {
          payload: { title: "No row tool" }
        });
        const unboundId = unbound.json<{ id: string }>().id;
        const missing = await say(
          unboundId,
          locale === "de"
            ? `Speichere einen Urlaubsantrag von Casey für den 2. bis 6. November im Datenspeicher ${subject.name}.`
            : `Store a holiday request from Casey for 2 to 6 November in Data Store ${subject.name}.`
        );
        expect(missing.status).toBe("completed");
        expect(textOf(await snapshot())).not.toContain("Casey");
        expect(await reply(unboundId, missing)).toMatch(
          locale === "de"
            ? /(?:nicht|kein|erst|fortsetzen|weiter)/iu
            : /(?:not|no |cannot|continue|can.t)/iu
        );
        const finalAsset = required(
          await world.stores.configAssets.getConfigAsset({
            clientInstanceId,
            kind: "data_store",
            name: subject.name
          })
        );
        expect(definitionSchema(finalAsset.config).join("\n")).not.toMatch(
          /\b(?:insert|update|delete|copy)\b/iu
        );
        expect([...live.models].some((model) => model.includes("opus"))).toBe(true);
      } finally {
        await writeFile(
          `../records-agent-live-${locale}.json`,
          JSON.stringify({ models: [...live.models], transcript }, null, 2)
        );
        await sql.end();
      }
    }
  );
});
