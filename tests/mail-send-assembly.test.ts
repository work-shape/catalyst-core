import { afterEach, describe, expect, it } from "vitest";
import {
  mailSendersOf,
  outboundMailOf,
  releaseToolNames
} from "@work-shape/catalyst-client-assembly";
import { parseClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import { asClientInstanceId, asConversationId } from "@work-shape/catalyst-core";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance, getTestExecution, type TestInstance } from "./support/test-instance";

// MAIL-1, check 129 and the chat half of check 133: `mail.send` exists only where release config
// switches outbound mail on, and a person without `mail_sender.use` on `system` is not offered it.

const instances: TestInstance[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.close()));
});

const capture = {
  provider: "capture",
  appUrl: "http://127.0.0.1:5173",
  sender: { fromAddress: "noreply@example.test" }
};

function configWith(mail: Record<string, unknown> | undefined) {
  const base = createTestConfig();
  return parseClientInstanceConfig({
    ...base,
    infrastructure: { ...base.infrastructure, ...(mail ? { mail } : {}) }
  });
}

async function started(mail: Record<string, unknown> | undefined) {
  const config = configWith(mail);
  const instance = await createTestInstance({ execution: { config, env: {}, tools: [] } });
  instances.push(instance);
  return { config, instance, execution: getTestExecution(instance) };
}

describe("mail.send on the instance (MAIL-1)", () => {
  it("is no operation, tool or sender while outbound mail is off", async () => {
    const { config, execution } = await started(capture);
    expect(outboundMailOf(config)).toBeUndefined();
    expect(mailSendersOf(config)).toEqual([]);
    expect(releaseToolNames(config).has("mail.send")).toBe(false);
    await expect(
      execution.operationCalls.registry.resolve("mail.send", execution.store)
    ).resolves.toBeUndefined();
    expect(execution.localAgentRuntimeOptions.toolRegistry.has("mail.send")).toBe(false);
  });

  it("registers the operation, the tool and the sender system where it is on", async () => {
    const { config, execution } = await started({
      ...capture,
      outbound: { enabled: true, recipientDomains: ["example.test"] }
    });
    expect(mailSendersOf(config)).toEqual(["system"]);
    expect(releaseToolNames(config).has("mail.send")).toBe(true);
    const operation = await execution.operationCalls.registry.resolve("mail.send", execution.store);
    expect(operation).toMatchObject({
      name: "mail.send",
      effect: "changing",
      changeClass: "outward",
      action: "mail_sender.use",
      rightNeededAtPublish: true
    });
    expect(execution.localAgentRuntimeOptions.toolRegistry.has("mail.send")).toBe(true);
  });

  it("stops startup naming the key where outbound mail has no provider", () => {
    expect(() => configWith({ outbound: { enabled: true } })).toThrow(/infrastructure\.mail/u);
  });

  it("withholds mail.send in chat from a member without the right, and offers it to an admin", async () => {
    const { execution } = await started({
      ...capture,
      outbound: { enabled: true, recipientDomains: ["example.test"] }
    });
    const clientInstanceId = asClientInstanceId(execution.clientInstanceId);
    const offerTo = async (roles: ("user" | "admin")[]) => {
      const record = await execution.store.users.createUser({
        clientInstanceId,
        displayLabel: roles.join("-"),
        roles
      });
      const workspace = await execution.store.workspaces.ensurePersonalWorkspace({
        clientInstanceId,
        userId: record.id
      });
      const conversation = await execution.store.conversations.createConversation({
        visibility: "private",
        clientInstanceId,
        collaborationWorkspaceId: workspace.id,
        createdByUserId: record.id,
        createdByExternalUserId: `external_${record.id}`,
        title: "Mail",
        retainedUntil: "2099-01-01T00:00:00.000Z"
      });
      return execution.localAgentRuntimeOptions.conversationOffer.offerOf({
        clientInstanceId,
        conversationId: asConversationId(conversation.id),
        agentToolNames: ["mail.send"],
        user: {
          id: record.id,
          externalUserId: `external_${record.id}`,
          displayLabel: record.displayLabel,
          roles,
          permissionRefs: [],
          clientInstanceId,
          authSource: "test"
        }
      });
    };
    expect((await offerTo(["user"]))?.withheldToolNames).toEqual(["mail.send"]);
    expect((await offerTo(["user", "admin"]))?.withheldToolNames).toBeUndefined();
  });
});
