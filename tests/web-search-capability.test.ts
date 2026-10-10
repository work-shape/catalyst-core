import { describe, expect, it } from "vitest";
import {
  findModelToolMaterializationIssues,
  materializeModelTools
} from "@vivd-catalyst/agent-runtime";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import {
  AppError,
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  type AgentConfig,
  type WebAccessConfig
} from "@vivd-catalyst/core";
import {
  createModelGateway,
  type ModelAdapterRequest,
  type ModelNativeToolId
} from "@vivd-catalyst/model-provider";
import {
  ALL_MODEL_CAPABILITIES,
  adapterFromFakeProvider,
  silentTestLogger
} from "./support/model-gateway";

const agent: AgentConfig = {
  name: "researcher",
  displayName: "Researcher",
  instructions: "Answer with sources.",
  toolNames: ["demo.echo", "web_search"],
  skillNames: [],
  initialPrompts: []
};
const webAccess: WebAccessConfig = {
  enabled: true,
  search: { enabled: true },
  fetch: {
    enabled: false,
    timeoutMs: 10_000,
    maxResponseBytes: 1024,
    maxTextCharacters: 1024,
    maxRedirects: 0
  }
};
const toolRegistry = {
  listDescriptorsForAgent: (toolNames: readonly string[]) =>
    toolNames.map((name) => ({
      name,
      description: `Tool ${name}`,
      inputJsonSchema: { type: "object", additionalProperties: true }
    }))
};

/** A gateway over one fake adapter that declares the given native tools and nothing else special. */
function gatewayDeclaring(nativeTools: ModelNativeToolId[]) {
  const requests: Pick<ModelAdapterRequest, "tools">[] = [];
  const entry = { id: "main", type: "fake", model: "fake-model" };
  const gateway = createModelGateway({
    providers: [entry],
    bindings: [],
    adapters: new Map([
      [
        entry.id,
        adapterFromFakeProvider(
          entry,
          {
            async complete(request) {
              requests.push({ tools: request.tools });
              return {
                text: "ok",
                toolCalls: [],
                usage: {
                  inputTokens: 0,
                  outputTokens: 0,
                  totalTokens: 0,
                  source: "not_reported",
                  webSearchCallCount: 0
                }
              };
            }
          },
          { ...ALL_MODEL_CAPABILITIES, nativeTools }
        )
      ]
    ]),
    governance: {
      runModelCall: (_call, execute) => execute(),
      recordModelUsage: async () => undefined
    },
    logger: silentTestLogger
  });
  /** One model call for the agent, with the tools the runtime would offer its model. */
  async function callForAgent(): Promise<void> {
    await gateway.complete({
      binding: { providerId: entry.id },
      messages: [{ role: "user", content: "What changed this week?" }],
      tools: materializeModelTools({
        agent,
        capabilities: gateway.capabilities({ providerId: entry.id }),
        toolRegistry,
        webAccess
      }),
      attribution: {
        kind: "agent_run",
        conversationId: asConversationId("conv_search"),
        runId: asAgentRunId("run_search"),
        agentName: agent.name,
        userId: "user-1"
      },
      clientInstanceId: asClientInstanceId("web-search-capability-test"),
      correlationId: "web-search-capability-test"
    });
  }
  return { gateway, requests, callForAgent };
}

describe("web search as a capability of the model", () => {
  it("offers the model the adapter's own web search when the adapter declares it", async () => {
    const f = gatewayDeclaring(["web_search"]);

    await f.callForAgent();

    expect(f.requests).toEqual([
      {
        tools: [
          expect.objectContaining({ kind: "function", name: "demo.echo" }),
          { kind: "provider", name: "web_search" }
        ]
      }
    ]);
    expect(
      findModelToolMaterializationIssues({
        agent,
        capabilities: f.gateway.capabilities({ providerId: "main" }),
        webAccess
      })
    ).toEqual([]);
  });

  it("leaves web search out and says so in agent validation when the adapter does not declare it", async () => {
    const f = gatewayDeclaring([]);

    await f.callForAgent();

    expect(f.requests).toEqual([
      { tools: [expect.objectContaining({ kind: "function", name: "demo.echo" })] }
    ]);
    expect(
      findModelToolMaterializationIssues({
        agent,
        capabilities: f.gateway.capabilities({ providerId: "main" }),
        webAccess
      })
    ).toEqual([
      "Agent 'researcher' references web_search but the model of this agent cannot search the web"
    ]);
  });

  it("keeps the instance switch: a model that can search is not offered it when search is off", async () => {
    const capabilities = gatewayDeclaring(["web_search"]).gateway.capabilities({
      providerId: "main"
    });
    const off = { ...webAccess, search: { enabled: false } };

    expect(
      materializeModelTools({ agent, capabilities, toolRegistry, webAccess: off }).map(
        (tool) => tool.name
      )
    ).toEqual(["demo.echo"]);
    expect(findModelToolMaterializationIssues({ agent, capabilities, webAccess: off })).toEqual([
      "Agent 'researcher' references web_search but webAccess.search is disabled"
    ]);
  });

  it.each(["mode", "managedProvider"])(
    "refuses a config that still sets webAccess.search.%s and names the key",
    (key) => {
      let refusal: unknown;
      try {
        parseClientInstanceConfig({
          version: 1,
          clientInstance: {
            id: "web-search-capability-test",
            displayName: "Web Search Capability Test",
            environment: "development"
          },
          auth: { development: { enabled: true } },
          infrastructure: { models: { local: { provider: "deterministic", model: "local" } } },
          webAccess: { enabled: true, search: { enabled: true, [key]: "native_or_managed" } },
          tools: []
        });
      } catch (error) {
        refusal = error;
      }

      expect(refusal).toBeInstanceOf(AppError);
      expect(refusal).toMatchObject({
        code: "VALIDATION_FAILED",
        details: {
          issues: [
            expect.objectContaining({
              message: expect.stringContaining(`'webAccess.search.${key}' was removed`)
            })
          ]
        }
      });
    }
  );

  it("names every removed key in the one message startup reports", () => {
    expect(() =>
      parseClientInstanceConfig({
        version: 1,
        clientInstance: {
          id: "web-search-capability-test",
          displayName: "Web Search Capability Test",
          environment: "development"
        },
        auth: { development: { enabled: true } },
        infrastructure: { models: { local: { provider: "deterministic", model: "local" } } },
        webAccess: {
          enabled: true,
          search: { enabled: true, mode: "native_or_managed", managedProvider: "none" }
        },
        tools: []
      })
    ).toThrow(
      "Client instance config is invalid: webAccess.search: 'webAccess.search.mode' and 'webAccess.search.managedProvider' were removed: whether a model can search the web is declared by its provider, and 'webAccess.search.enabled' is the only switch. Delete the keys"
    );
  });
});
