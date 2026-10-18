import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  asClientInstanceId,
  createConnectorTypeRegistry,
  type ConnectionCredentialResolver
} from "@work-shape/catalyst-core";
import {
  ConnectionCallSlots,
  createConnectionOperationSource
} from "@work-shape/catalyst-connections";
import { deferred, required, waitUntil } from "./support/assertions";
import { createOAuthWorld, landingOf, type OAuthWorld } from "./support/oauth-sign-in-world";
import { getTestExecution } from "./support/test-instance";
import { withTestSql } from "./support/test-sql";
import { z } from "zod";

const clientInstanceId = asClientInstanceId("demo-local");
const startAnswer = z.object({ authorizationUrl: z.string().url() });
let world: OAuthWorld;

beforeAll(async () => {
  world = await createOAuthWorld();
}, 60_000);

afterAll(async () => {
  await world?.close();
});

async function reconnect(cookie: string): Promise<void> {
  const started = await world.start("dcr", cookie);
  expect(started.status).toBe(200);
  const back = await world.authorize(startAnswer.parse(started.body).authorizationUrl);
  const landed = await world.callback(back, { cookie });
  expect(landingOf(landed.location)).toEqual({ signIn: "connected", connection: "dcr" });
  await world.discover("dcr", cookie);
}

describe("an approved OAuth call whose sign-in changes while it waits", () => {
  it.each(["slot", "egress", "credential"] as const)(
    "refuses approval_stale after a reconnect during the %s wait, before any outside execution",
    async (pauseAt) => {
      const alice = await world.signIn("alice");
      await reconnect(alice);
      const made = await world.call("dcr", "list_customers", alice);
      expect(made.result).toMatchObject({ status: "done" });
      // As in the lifecycle test: the existing run represents a decided, held call.
      await withTestSql(
        (sql) => sql`
          update operation_runs set decision = ${sql.json({
            mode: "approved",
            by: "user-bob",
            at: new Date().toISOString()
          })} where id = ${made.run.id}`
      );
      const assembly = getTestExecution(world.worker);
      const connections = required(assembly.connections);
      const credentials = required(connections.credentials);
      const original = required(connections.connectorTypes.get("mcp"));
      const execute = vi.fn(original.execute);
      const slots = new ConnectionCallSlots();
      const paused = deferred<void>();
      const resume = deferred<void>();
      const wrapped: ConnectionCredentialResolver = {
        resolve: (input) => credentials.resolve(input),
        async resolveSignIn(input) {
          if (pauseAt === "credential") {
            paused.resolve();
            await resume.promise;
          }
          return credentials.resolveSignIn(input);
        }
      };
      const source = createConnectionOperationSource(
        {
          clientInstanceId,
          stores: assembly.store,
          logger: assembly.logger,
          connectorTypes: createConnectorTypeRegistry([
            { ...original, execute, limits: { ...original.limits, maxParallelCalls: 1 } }
          ]),
          credentials: wrapped,
          egress: {
            async check(target) {
              if (pauseAt === "egress") {
                paused.resolve();
                await resume.promise;
              }
              return connections.egress.check(target);
            }
          }
        },
        slots
      );
      const definition = required(await source.resolve("connection.dcr.list_customers"));
      const asset = required(
        await assembly.store.configAssets.getConfigAsset({
          clientInstanceId,
          kind: "connection",
          name: "dcr"
        })
      );
      const held =
        pauseAt === "slot"
          ? await slots.acquire(asset.id, { maxParallelCalls: 1, slotWaitMs: 10_000 })
          : undefined;
      const calls = await world.calls();
      const actor = await world.identityOf(alice);
      const pending = definition
        .execute(
          {},
          {
            runId: made.run.id,
            actor,
            origin: { kind: "cli" },
            correlationId: "corr_held_wait",
            runtime: {},
            access: await calls.deps.authorizer.forActor(actor),
            audit: calls.deps.audit
          }
        )
        .then(
          () => undefined,
          (error: unknown) => error
        );
      try {
        if (pauseAt === "slot") {
          await waitUntil(() => slots.waiting(asset.id) === 1, "the held call queues for a slot");
        } else {
          await paused.promise;
        }
        await reconnect(alice);
      } finally {
        held?.release();
        resume.resolve();
      }
      const failure = await pending;
      expect(execute).toHaveBeenCalledTimes(0);
      expect(failure).toMatchObject({ details: { reason: "approval_stale" } });
    }
  );
});
