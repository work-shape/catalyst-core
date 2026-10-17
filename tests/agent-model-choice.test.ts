import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentRuntime } from "@work-shape/catalyst-core";
import {
  agent,
  errorSchema,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";

// The model control of the composer shows to a member only where the agent's author offered a
// choice: more than one model, or a reasoning effort left open. The efforts a model binding
// allows are no choice by themselves. Whoever may write the agent is offered them as before
// (UX audit ruling 4, UXA-7c). The interface shows no control where nothing is offered.

const offeredSchema = z.object({
  agents: z.array(
    z.object({
      name: z.string(),
      selectableModels: z.array(
        z.object({
          bindingId: z.string().optional(),
          selectableReasoningEfforts: z.array(z.string())
        })
      )
    })
  )
});
const workspaceSchema = z.object({ id: z.string() });
const workspaceAgentsSchema = z.object({ items: offeredSchema.shape.agents });

describe("the choice of model a member is offered", () => {
  let open: AccessInstance | undefined;
  afterEach(async () => {
    await open?.instance.close();
    open = undefined;
  });

  /** The efforts each model of the agent offers the caller, by the agent's name. */
  async function effortsFor(t: AccessInstance, userId: string, agentName: string) {
    const config = offeredSchema.parse((await t.expectOk(userId, "config.get")).json());
    return config.agents
      .find((offered) => offered.name === agentName)
      ?.selectableModels.map((model) => model.selectableReasoningEfforts);
  }

  it("offers efforts a member only where the author left the effort open", async () => {
    open = await setupAccessInstance({
      storedAssetSource: true,
      modelBindings: [
        {
          id: "plain",
          providerId: "local",
          reasoningEffort: "medium",
          userSelectableReasoningEfforts: ["low", "high"]
        },
        { id: "other", providerId: "local" }
      ]
    });
    const t = open;
    const onPlain = { modelProviderId: undefined, modelBindingId: "plain" };
    await t.expectOk(t.root.id, "assets.put", {
      params: { kind: "agent", name: "fixed" },
      payload: {
        config: agent("fixed", { ...onPlain, reasoningEffort: "high" }),
        availableIn: "all"
      }
    });
    await t.expectOk(t.root.id, "assets.put", {
      params: { kind: "agent", name: "open" },
      payload: { config: agent("open", onPlain), availableIn: "all" }
    });
    const everyEffort = ["low", "medium", "high"];

    // Kai holds no right on either agent.
    expect(await effortsFor(t, t.kai.id, "fixed")).toEqual([[]]);
    expect(await effortsFor(t, t.kai.id, "open")).toEqual([everyEffort]);
    // The superadmin, who may write both, is offered what the binding allows.
    expect(await effortsFor(t, t.root.id, "fixed")).toEqual([["low", "high"]]);
    expect(await effortsFor(t, t.root.id, "open")).toEqual([everyEffort]);

    // The workspace's own list of agents, which the picker reads, offers the same.
    const personal = workspaceSchema.parse(
      (await t.expectOk(t.kai.id, "workspaces.ensure_personal")).json()
    );
    const listed = workspaceAgentsSchema.parse(
      (
        await t.expectOk(t.kai.id, "workspaces.agents.list", {
          params: { collaborationWorkspaceId: personal.id }
        })
      ).json()
    );
    expect(
      listed.items.find((offered) => offered.name === "fixed")?.selectableModels[0]
        ?.selectableReasoningEfforts
    ).toEqual([]);

    // A right on this one agent, granted by its id, makes Kai a writer of it.
    await t.grant(t.kai.id, "agent.write", { assetId: await t.assetId("agent", "fixed") });
    expect(await effortsFor(t, t.kai.id, "fixed")).toEqual([["low", "high"]]);
  });

  it("starts a run for a member only with a model and an effort the author offered", async () => {
    // The effort of every run the runtime was asked to start.
    const startedWith: (string | undefined)[] = [];
    const refuse = (): never => {
      throw new Error("Not used here");
    };
    const runtime: AgentRuntime = {
      async start(input) {
        startedWith.push(input.reasoningEffort);
        // The run start service always hands over the run it prepared.
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
      modelBindings: [
        {
          id: "plain",
          providerId: "local",
          reasoningEffort: "medium",
          userSelectableReasoningEfforts: ["low", "high"]
        },
        {
          id: "other",
          providerId: "local",
          reasoningEffort: "medium",
          userSelectableReasoningEfforts: ["low", "high"]
        }
      ]
    });
    const t = open;
    // The author set `high` for the agent's own model and for the model listed beside it.
    await t.expectOk(t.root.id, "assets.put", {
      params: { kind: "agent", name: "fixed" },
      payload: {
        config: agent("fixed", {
          modelProviderId: undefined,
          modelBindingId: "plain",
          reasoningEffort: "high",
          userSelectableModelBindingIds: ["other"],
          modelReasoningEfforts: { other: "high" }
        }),
        availableIn: "all"
      }
    });
    let key = 0;
    const ask = (modelBindingId: string | undefined, reasoningEffort: string | undefined) => ({
      agentName: "fixed",
      idempotencyKey: `choice-${(key += 1)}`,
      message: { text: "Hello" },
      ...(modelBindingId === undefined ? {} : { modelBindingId }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort })
    });
    /** The status and reason of a run started both ways: in a new and in an open conversation. */
    const startBothWays = async (
      userId: string,
      modelBindingId: string | undefined,
      reasoningEffort: string | undefined
    ) => {
      const created = await t.call(userId, "conversations.runs.create", {
        payload: ask(modelBindingId, reasoningEffort)
      });
      const conversation = z
        .object({ id: z.string() })
        .parse((await t.expectOk(userId, "conversations.create", { payload: {} })).json());
      const started = await t.call(userId, "conversations.runs.start", {
        params: { conversationId: conversation.id },
        payload: ask(modelBindingId, reasoningEffort)
      });
      const outcome = (response: typeof created) => {
        const refused = errorSchema.safeParse(response.json());
        return refused.success
          ? `${response.statusCode} ${String(refused.data.error.details?.reason)}`
          : `${response.statusCode}`;
      };
      return [outcome(created), outcome(started)];
    };
    const ok = ["200", "200"];
    /** The efforts the runs started since the last look ran with. */
    const ranWith = () => startedWith.splice(0);
    const effortRefused = ["422 effort_not_offered", "422 effort_not_offered"];

    // Kai may not write the agent: another effort is refused for either model, the author's
    // effort and none at all pass.
    expect(await startBothWays(t.kai.id, undefined, "low")).toEqual(effortRefused);
    expect(await startBothWays(t.kai.id, "other", "low")).toEqual(effortRefused);
    expect(await startBothWays(t.kai.id, undefined, "high")).toEqual(ok);
    expect(await startBothWays(t.kai.id, "other", "high")).toEqual(ok);
    expect(await startBothWays(t.kai.id, "other", undefined)).toEqual(ok);
    // A run that names no effort leaves it to the runtime, which takes the author's.
    expect(ranWith()).toEqual(["high", "high", "high", "high", undefined, undefined]);
    // A model the author did not offer is refused to everyone.
    expect(await startBothWays(t.kai.id, "unlisted", undefined)).toEqual([
      "422 model_not_offered",
      "422 model_not_offered"
    ]);

    // As a writer of the agent Kai is offered what the models allow, as before.
    await t.grant(t.kai.id, "agent.write", { assetId: await t.assetId("agent", "fixed") });
    expect(await startBothWays(t.kai.id, undefined, "low")).toEqual(ok);
    expect(await startBothWays(t.kai.id, "other", "low")).toEqual(ok);
    expect(ranWith()).toEqual(["low", "low", "low", "low"]);
    // An effort no model allows stays refused to a writer too.
    expect(await startBothWays(t.kai.id, undefined, "xhigh")).toEqual(effortRefused);
  });
});
