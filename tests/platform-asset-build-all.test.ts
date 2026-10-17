import { PLATFORM_TOOL_NAMES } from "@work-shape/catalyst-client-assembly";
import { WORKFLOW_ASSET_KIND, asConversationId } from "@work-shape/catalyst-core";
import { DeterministicModelProvider } from "@work-shape/catalyst-model-provider";
import {
  createPlatformAssetBinding,
  createPlatformAssetTools
} from "@work-shape/catalyst-tool-execution";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createAssetToolsFixture,
  OTHER,
  WORKFLOW,
  added,
  manifest,
  result,
  runSchema,
  subjectSchema,
  trigger,
  writeSchema
} from "./support/platform-asset-tools";

// One conversation builds what an App needs (BUILD-ALL-1; Platform Access check 60, Workflows
// check 73). In a conversation about an App the agent creates the Workflow the App needs beside
// it, keeps saving and test-running that draft, and the conversation stays about the App. An
// asset that existed before changes only as the subject. The model is the scripted one of the
// tests, which makes the one tool call each message names. Each case fails without the change:
// a create in a conversation about an asset was refused, and a save or a test reached the
// subject only.

const APP = { kind: "app", name: "invoice-desk" };
const CREATED = "invoice-check";
const config = (steps: unknown[] = []) => ({
  name: CREATED,
  manifest: {
    ...manifest(),
    id: CREATED,
    name: "Invoice check",
    steps: [trigger, ...steps, result]
  }
});

const createdSchema = z.object({
  saved: z.literal(true),
  revision: z.number(),
  created: z.literal(true),
  kind: z.string(),
  name: z.string(),
  title: z.string(),
  besideSubject: z.literal(true)
});

describe("one conversation that builds what an App needs", () => {
  beforeAll(() => {
    // The demo provider paces every word of its tool-result echo; these tests need its result.
    vi.spyOn(DeterministicModelProvider.prototype, "stream").mockImplementation(async function* (
      this: DeterministicModelProvider,
      request
    ) {
      yield { type: "completed", completion: await this.complete(request) };
    });
  });
  afterAll(() => vi.restoreAllMocks());

  it("creates, saves and tests a Workflow draft beside its App, and changes no Workflow that existed before", async () => {
    const t = await createAssetToolsFixture();
    const about = async (as?: string) => {
      const { id } = z
        .object({ id: z.string() })
        .parse((await t.ok(t.converse(undefined, as))).json());
      // The conversation is about the App: the App's own content plays no part in the rule.
      await t.app.stores.conversations.setConversationSubject({
        clientInstanceId: t.clientInstanceId,
        conversationId: asConversationId(id),
        subject: APP
      });
      return id;
    };
    const subjectOf = async (id: string) =>
      z
        .object({ conversation: z.object({ subject: subjectSchema.optional() }) })
        .parse(
          (
            await t.ok(t.app.call("conversations.thread.get", { params: { conversationId: id } }))
          ).json()
        ).conversation.subject;
    const id = await about();

    // The agent says first what it creates: the save's description asks it to.
    const put = createPlatformAssetTools(createPlatformAssetBinding().calls).find(
      (tool) => tool.name === "platform.assets.put"
    );
    expect(put?.description).toContain("Dafür legen wir zuerst den Workflow an.");

    // The create stands beside the App: the conversation stays about the App.
    const created = createdSchema.parse(
      await t.call(id, "platform.assets.put", {
        kind: WORKFLOW_ASSET_KIND,
        name: CREATED,
        config: config()
      })
    );
    expect(created).toMatchObject({ revision: 1, kind: WORKFLOW_ASSET_KIND, name: CREATED });
    expect(await subjectOf(id)).toEqual(APP);

    // It keeps checking and saving the draft it created, twice, naming it.
    expect(
      await t.call(id, "platform.assets.validate", {
        kind: WORKFLOW_ASSET_KIND,
        name: CREATED,
        config: config()
      })
    ).toEqual({ valid: true, issues: [] });
    let revision = created.revision;
    for (const steps of [[], [added]]) {
      const saved = writeSchema.parse(
        await t.call(id, "platform.assets.put", {
          kind: WORKFLOW_ASSET_KIND,
          name: CREATED,
          config: config(steps),
          expectedRevision: revision
        })
      );
      expect(saved).toEqual({ saved: true, revision: revision + 1 });
      revision += 1;
    }
    expect(await subjectOf(id)).toEqual(APP);

    // And it test-runs the draft as the person, with itself as origin (Workflows check 73).
    const started = runSchema
      .extend({ mode: z.literal("test"), operationRunId: z.string() })
      .parse(
        await t.call(id, "workflows.test", { workflow: CREATED, input: { note: "Rechnung 7" } })
      );
    const draft = await t.app.stores.configAssets.getConfigAsset({
      clientInstanceId: t.clientInstanceId,
      kind: WORKFLOW_ASSET_KIND,
      name: CREATED
    });
    expect(started.definitionRevisionId).toBe(draft?.activeRevisionId);
    const runs = await t.app.stores.operationRuns.list({ clientInstanceId: t.clientInstanceId });
    expect(runs.find((run) => run.id === started.operationRunId)).toMatchObject({
      operation: "workflows.test",
      actor: { kind: "user" },
      origin: { kind: "agent", conversationId: id, toolName: "workflows.test" }
    });

    // The published Workflow existed before the conversation: no save or test reaches it
    // without an open, whatever the model names.
    const before = await t.asset();
    const refused = await t.say(
      id,
      `/tool platform.assets.put ${JSON.stringify({ kind: WORKFLOW_ASSET_KIND, name: WORKFLOW, config: { name: WORKFLOW, manifest: manifest([added]) }, expectedRevision: before.revision })}`
    );
    expect(refused.answer).toContain(`did not create the workflow '${WORKFLOW}'`);
    expect(await t.asset()).toEqual(before);
    const untested = await t.say(
      id,
      `/tool workflows.test ${JSON.stringify({ workflow: WORKFLOW, input: { note: "x" } })}`
    );
    expect(untested.answer).toContain("An agent may test only the conversation's subject Workflow");

    // Another conversation of the same person did not create the draft: it does not reach it.
    const elsewhere = await about();
    const foreign = await t.say(
      elsewhere,
      `/tool platform.assets.put ${JSON.stringify({ kind: WORKFLOW_ASSET_KIND, name: CREATED, config: config(), expectedRevision: revision })}`
    );
    expect(foreign.answer).toContain(`did not create the workflow '${CREATED}'`);

    // A draft deleted and made anew under its name is another asset: the conversation that
    // created the first one no longer reaches it.
    await t.ok(
      t.app.call("assets.delete", {
        params: { kind: WORKFLOW_ASSET_KIND, name: CREATED },
        payload: { expectedRevision: revision }
      })
    );
    await t.ok(
      t.app.call("assets.put", {
        params: { kind: WORKFLOW_ASSET_KIND, name: CREATED },
        // Made again, it names the revision of its delete.
        payload: { config: config(), expectedRevision: revision + 1 }
      })
    );
    const anew = await t.app.stores.configAssets.getConfigAsset({
      clientInstanceId: t.clientInstanceId,
      kind: WORKFLOW_ASSET_KIND,
      name: CREATED
    });
    const remade = await t.say(
      id,
      `/tool platform.assets.put ${JSON.stringify({ kind: WORKFLOW_ASSET_KIND, name: CREATED, config: config(), expectedRevision: anew?.revision })}`
    );
    expect(remade.answer).toContain(`did not create the workflow '${CREATED}'`);

    // A person without the right to write a Workflow creates none, told the right it needs.
    const theirs = await about(OTHER);
    const denied = await t.say(
      theirs,
      `/tool platform.assets.put ${JSON.stringify({ kind: WORKFLOW_ASSET_KIND, name: "their-check", config: { ...config(), name: "their-check" } })}`,
      OTHER
    );
    expect(denied.answer).toContain("workflow.write");
    expect(
      await t.app.stores.configAssets.getConfigAsset({
        clientInstanceId: t.clientInstanceId,
        kind: WORKFLOW_ASSET_KIND,
        name: "their-check"
      })
    ).toBeUndefined();

    // No tool of the conversation publishes either asset.
    expect(PLATFORM_TOOL_NAMES.filter((name) => name.includes("publish"))).toEqual([]);
  }, 180_000);
});
