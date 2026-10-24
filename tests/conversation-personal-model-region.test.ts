import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { asConversationId, type AgentRuntime } from "@work-shape/catalyst-core";
import {
  agent,
  clientInstanceId,
  errorSchema,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";

// MODEL-REGION-3: in a conversation that holds data from a personal connection, a run start or
// a follow-up that names a model outside `personalModelRegions`, or falls back to one, is
// refused before the run is created. The picker learns which models that is from config.get.

const offeredSchema = z.object({
  agents: z.array(
    z.object({
      name: z.string(),
      selectableModels: z.array(
        z.object({
          bindingId: z.string().optional(),
          personalDataBlocked: z.literal(true).optional()
        })
      )
    })
  )
});
const idSchema = z.object({ id: z.string() });

describe("a conversation with personal data starts runs only on allowed models", () => {
  let open: AccessInstance | undefined;
  afterEach(async () => {
    await open?.instance.close();
    open = undefined;
  });

  async function setup(connections: boolean) {
    const started: (string | undefined)[] = [];
    const refuse = (): never => {
      throw new Error("Not used here");
    };
    const runtime: AgentRuntime = {
      async start(input) {
        started.push(input.modelBindingId);
        const prepared = input.preparedRun ?? refuse();
        return { runId: prepared.id, status: "queued", startedAt: prepared.startedAt };
      },
      observe: () => refuse(),
      getStatus: async () => refuse(),
      resume: async () => refuse(),
      cancel: async () => refuse()
    };
    open = await setupAccessInstance({
      storedAssetSource: true,
      server: () => ({ agentRuntime: runtime }),
      ...(connections ? { modules: { connections: { enabled: true } } } : {}),
      models: {
        local: { provider: "deterministic", model: "local", region: "eu" },
        abroad: { provider: "deterministic", model: "abroad", region: "us" }
      },
      modelBindings: [
        { id: "plain", providerId: "local" },
        { id: "other", providerId: "abroad" }
      ]
    });
    const t = open;
    for (const [name, own, offered] of [
      ["chooser", "plain", ["other"]],
      ["abroad_agent", "other", []]
    ] as const) {
      await t.expectOk(t.root.id, "assets.put", {
        params: { kind: "agent", name },
        payload: {
          config: agent(name, {
            modelProviderId: undefined,
            modelBindingId: own,
            userSelectableModelBindingIds: offered
          }),
          availableIn: "all"
        }
      });
    }
    let key = 0;
    const conversation = async (marked: boolean) => {
      const { id } = idSchema.parse(
        (await t.expectOk(t.kai.id, "conversations.create", { payload: {} })).json()
      );
      if (marked) {
        await t.stores.conversations.markPersonalData({
          clientInstanceId,
          conversationId: asConversationId(id),
          userId: t.kai.id,
          at: "2026-10-25T10:00:00.000Z"
        });
      }
      return id;
    };
    /** The status, and the reason of a refusal, of a start in the conversation. */
    const start = async (
      conversationId: string,
      agentName: string,
      modelBindingId?: string,
      followUp?: "queue"
    ) => {
      const response = await t.call(t.kai.id, "conversations.runs.start", {
        params: { conversationId },
        payload: {
          agentName,
          idempotencyKey: `region-${(key += 1)}`,
          message: { text: "Summarise my mail" },
          ...(modelBindingId ? { modelBindingId } : {}),
          ...(followUp ? { followUp } : {})
        }
      });
      const refused = errorSchema.safeParse(response.json());
      return {
        outcome: refused.success
          ? `${response.statusCode} ${String(refused.data.error.details?.reason)}`
          : `${response.statusCode}`,
        body: JSON.stringify(response.json())
      };
    };
    const runs = (conversationId: string) =>
      t.stores.agentRuns.getLatestConversationAgentRun({
        clientInstanceId,
        conversationId: asConversationId(conversationId)
      });
    const blocked = async () =>
      Object.fromEntries(
        offeredSchema
          .parse((await t.expectOk(t.kai.id, "config.get")).json())
          .agents.flatMap((offered) => (offered.name === "chooser" ? offered.selectableModels : []))
          .map((model) => [model.bindingId, model.personalDataBlocked ?? false])
      );
    return { t, started, conversation, start, runs, blocked };
  }

  it("refuses the us model a later turn names, and the agent whose own model is on us", async () => {
    const { started, conversation, start, runs, blocked } = await setup(true);
    // The picker learns which model a conversation with personal data cannot use.
    expect(await blocked()).toEqual({ plain: false, other: true });

    const marked = await conversation(true);
    const refused = await start(marked, "chooser", "other");
    expect(refused.outcome).toBe("403 personal_data_model_region");
    // The refusal names the allowed regions, never the route, the model or the message.
    expect(refused.body).not.toMatch(/abroad|"us"|Summarise/u);
    expect((await start(marked, "abroad_agent")).outcome).toBe("403 personal_data_model_region");
    expect(started).toEqual([]);
    expect(await runs(marked)).toBeUndefined();

    // The same conversation goes on with an allowed model.
    expect((await start(marked, "chooser")).outcome).toBe("200");
    expect(started).toEqual([undefined]);
  });

  it("refuses a follow-up queued behind a running turn on a blocked model", async () => {
    const { started, conversation, start } = await setup(true);
    const marked = await conversation(true);
    expect((await start(marked, "chooser", "plain")).outcome).toBe("200");
    expect((await start(marked, "chooser", "other", "queue")).outcome).toBe(
      "403 personal_data_model_region"
    );
    expect((await start(marked, "chooser", "plain", "queue")).outcome).toBe("200");
    expect(started).toEqual(["plain"]);
  });

  it("leaves a conversation without the mark as before", async () => {
    const { conversation, start } = await setup(true);
    expect((await start(await conversation(false), "chooser", "other")).outcome).toBe("200");
  });

  it("leaves an instance without Connections as before", async () => {
    const { blocked, conversation, start } = await setup(false);
    expect(await blocked()).toEqual({ plain: false, other: false });
    expect((await start(await conversation(true), "chooser", "other")).outcome).toBe("200");
    expect((await start(await conversation(true), "abroad_agent")).outcome).toBe("200");
  });
});
