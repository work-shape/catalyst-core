import { PLATFORM_TOOL_NAMES } from "@vivd-catalyst/client-assembly";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { asClientInstanceId } from "@vivd-catalyst/core";
import { drainRunEvents, injectStartConversationRun } from "./support/chat-server-run-harness";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance, type TestInstance } from "./support/test-instance";

// The agent edits the draft of a Guardrail with the platform's asset tools, as it edits a
// Workflow's: a conversation about the Guardrail binds the tools to it, a save writes the
// draft, and nothing of it enforces until a person publishes it (EW-6a). Fails without the
// change: a Guardrail could not be written by any tool.

const NAME = "no-iban";
const subject = { kind: "guardrail", name: NAME };
const definition = (outcome: string) => ({
  name: NAME,
  displayName: "No IBAN in skills",
  on: "asset.before_write",
  filter: { kind: "skill" },
  check: { kind: "pattern", pattern: "DE\\d{20}", reason: "Skills hold no bank account." },
  outcome
});

const assetSchema = z.object({ revision: z.number(), publishedRevision: z.number().optional() });
const writeSchema = z.object({ saved: z.boolean(), revision: z.number().optional() });
const messagesSchema = z.object({
  items: z.array(z.object({ role: z.string(), text: z.string() }))
});

describe("a conversation about a Guardrail", () => {
  let open: TestInstance | undefined;
  afterEach(async () => {
    await open?.close();
    open = undefined;
  });

  it("lets the agent save a draft that enforces nothing until it is published", async () => {
    const config = createTestConfig({
      toolNames: [...PLATFORM_TOOL_NAMES],
      developmentAuth: {
        enabled: true,
        defaultUserId: "owner",
        users: [
          {
            id: "owner",
            externalUserId: "owner",
            displayLabel: "Owner",
            roles: ["user", "admin", "superadmin"]
          }
        ]
      }
    });
    config.modules = { assetManagement: { enabled: true } };
    config.administration.agentConfiguration.enabled = true;
    const app = await createTestInstance({ config, env: {}, tools: [] });
    open = app;
    const clientInstanceId = asClientInstanceId(config.clientInstance.id);
    const ok = async (response: ReturnType<TestInstance["call"]>) => {
      const answered = await response;
      expect(answered.statusCode, answered.body).toBe(200);
      return answered;
    };
    const written = assetSchema.parse(
      (
        await ok(
          app.call("assets.put", {
            params: subject,
            payload: { config: definition("warn"), expectedRevision: null }
          })
        )
      ).json()
    );
    await ok(
      app.call("assets.publish", { params: subject, payload: { revision: written.revision } })
    );

    const created = z
      .object({ id: z.string() })
      .parse(
        (await ok(app.call("conversations.create", { payload: { title: "Edit", subject } }))).json()
      );
    const started = await injectStartConversationRun(
      app,
      created.id,
      `/tool platform.assets.put ${JSON.stringify({ config: definition("block"), expectedRevision: written.revision })}`
    );
    await drainRunEvents(app, created.id, started.run.id);
    const messages = messagesSchema.parse(
      (
        await app.call("conversations.messages.list", { params: { conversationId: created.id } })
      ).json()
    );
    const answer: unknown = JSON.parse(
      messages.items.filter((message) => message.role === "tool").at(-1)?.text ?? "null"
    );
    expect(writeSchema.parse(answer)).toEqual({ saved: true, revision: written.revision + 1 });

    // The draft moved; what enforces is still the revision a person published.
    const stored = await app.stores.configAssets.getConfigAsset({ clientInstanceId, ...subject });
    expect(stored).toMatchObject({
      revision: written.revision + 1,
      publishedRevision: written.revision,
      publishedConfig: { outcome: "warn" }
    });
  });
});
