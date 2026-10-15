import { afterEach, describe, expect, it, vi } from "vitest";
import {
  asClientInstanceId,
  createProvider,
  type ModelBindingConfig,
  type ModelProviderConfig
} from "@work-shape/catalyst-core";
import { parseClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import {
  MODEL_EMBEDDING_MAX_TEXTS_PER_CALL,
  ModelProviderError,
  createModelGateway,
  modelProviderDefinitions,
  type ModelAdapter,
  type ModelAdapterEmbedding,
  type ModelAdapterEmbeddingRequest,
  type ModelCallGovernance,
  type ModelEmbeddingCall
} from "@work-shape/catalyst-model-provider";
import { ModelUsageGovernance } from "@work-shape/catalyst-usage-governance";
import { advanceFakeClockUntilSettled } from "./support/fake-clock";
import { createFakeSecrets } from "./support/fixtures";
import {
  ALL_MODEL_CAPABILITIES,
  createRecordingGovernance,
  silentTestLogger
} from "./support/model-gateway";
import { createTestInstance } from "./support/test-instance";

const clientInstanceId = asClientInstanceId("client-embeddings");
// Shorter than the first wait before a retry, so each wait of a retried call passes once.
const RETRY_CLOCK_STEP_MS = 500;
const DIMENSIONS = 8;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("embedding bindings in release config", () => {
  const releaseConfig = (overrides: Record<string, unknown> = {}) => ({
    clientInstance: { id: "embedding-config", displayName: "Embedding config" },
    infrastructure: {
      models: {
        local: { provider: "deterministic" },
        azure: {
          provider: "openai-compatible",
          region: "eu",
          model: "chat-deployment",
          baseUrl: "https://resource.example.test/openai/v1",
          credentialSecret: "AZURE_KEY",
          authMode: "api-key"
        },
        us: { provider: "openai-compatible", region: "global", model: "chat-model" }
      }
    },
    modelBindings: [
      { id: "chat", providerId: "azure" },
      { id: "embedding", providerId: "azure", kind: "embedding", model: "emb", dimensions: 1536 }
    ],
    knowledge: { defaultEmbeddingBinding: "embedding" },
    ...overrides
  });

  it("reads an embedding binding and the default, and offers it to no agent", () => {
    const config = parseClientInstanceConfig(releaseConfig());

    expect(config.modelBindings).toEqual([
      expect.objectContaining({ id: "chat", agentSelectable: true }),
      expect.objectContaining({
        id: "embedding",
        kind: "embedding",
        dimensions: 1536,
        agentSelectable: false
      })
    ]);
    expect(config.modelBindings[0]).not.toHaveProperty("kind");
    expect(config.knowledge).toEqual({ defaultEmbeddingBinding: "embedding" });
  });

  it("starts without an embedding binding and without a default", () => {
    const config = parseClientInstanceConfig(
      releaseConfig({ modelBindings: [{ id: "chat", providerId: "azure" }], knowledge: undefined })
    );

    expect(config.knowledge).toEqual({});
  });

  it("accepts an embedding binding on a provider that keeps data inside the instance", () => {
    const config = parseClientInstanceConfig(
      releaseConfig({
        modelBindings: [{ id: "embedding", providerId: "local", kind: "embedding", dimensions: 4 }]
      })
    );

    expect(config.knowledge.defaultEmbeddingBinding).toBe("embedding");
  });

  it.each([
    [
      "an embedding binding on an entry outside the EU",
      {
        modelBindings: [{ id: "embedding", providerId: "us", kind: "embedding", dimensions: 1536 }]
      },
      "Embedding binding 'embedding' is on model provider 'us', whose region is 'global'"
    ],
    [
      "an embedding binding without dimensions",
      { modelBindings: [{ id: "embedding", providerId: "azure", kind: "embedding" }] },
      "Embedding binding 'embedding' needs 'dimensions'"
    ],
    [
      "an embedding binding agents may choose",
      {
        modelBindings: [
          {
            id: "embedding",
            providerId: "azure",
            kind: "embedding",
            dimensions: 1536,
            agentSelectable: true
          }
        ]
      },
      "Embedding binding 'embedding' cannot be chosen for agents"
    ],
    [
      "dimensions on a chat binding",
      { modelBindings: [{ id: "chat", providerId: "azure", dimensions: 1536 }] },
      "Model binding 'chat' states 'dimensions'"
    ],
    [
      "dimensions that are no whole positive number",
      {
        modelBindings: [
          { id: "embedding", providerId: "azure", kind: "embedding", dimensions: 1.5 }
        ]
      },
      "modelBindings.0.dimensions"
    ],
    [
      "more dimensions than a vector column holds",
      {
        modelBindings: [
          { id: "embedding", providerId: "azure", kind: "embedding", dimensions: 16_001 }
        ]
      },
      "modelBindings.0.dimensions"
    ],
    [
      "an unknown kind",
      { modelBindings: [{ id: "chat", providerId: "azure", kind: "rerank" }] },
      "modelBindings.0.kind"
    ],
    [
      "a default that names no binding",
      { knowledge: { defaultEmbeddingBinding: "missing" } },
      "'knowledge.defaultEmbeddingBinding' names 'missing', which is no model binding of kind 'embedding'"
    ],
    [
      "a default that names a chat binding",
      { knowledge: { defaultEmbeddingBinding: "chat" } },
      "'knowledge.defaultEmbeddingBinding' names 'chat', which is no model binding of kind 'embedding'"
    ],
    [
      "a key of knowledge the platform does not know",
      { knowledge: { defaultEmbeddingModel: "embedding" } },
      "knowledge"
    ],
    [
      "a guardrail on the embedding binding",
      {
        guardrails: {
          guard: {
            on: "approval_request.before_create",
            check: { kind: "model_judge", modelBindingId: "embedding", instruction: "Check it." },
            outcome: "warn"
          }
        }
      },
      "Guardrail 'guard' names the embedding binding 'embedding', which answers no chat call"
    ],
    [
      "conversation titles on the embedding binding",
      { conversationTitles: { enabled: true, modelBindingId: "embedding" } },
      "Conversation title generation names the embedding binding 'embedding'"
    ],
    [
      "a spend budget without a price for the embedding model",
      {
        conversationTitles: { enabled: false },
        usage: {
          budget: { monthlySpendLimit: 10 },
          costs: { customer: { id: "rates", version: "1", models: [] } }
        }
      },
      "Spend budget requires configured customer pricing for model azure/emb"
    ]
  ])("stops startup on %s", (_case, overrides, message) => {
    expect(() => parseClientInstanceConfig(releaseConfig(overrides))).toThrow(message);
  });
});

describe("gateway.embed", () => {
  it("returns one stable vector of unit length per text from the deterministic adapter", async () => {
    const f = await fixture({ adapter: await deterministicAdapter() });

    const embedding = await f.gateway.embed(embedCall(["Mietvertrag", "Grundbuch", "Mietvertrag"]));

    expect(embedding.vectors).toHaveLength(3);
    for (const vector of embedding.vectors) {
      expect(vector).toHaveLength(DIMENSIONS);
      expect(Math.hypot(...vector)).toBeCloseTo(1, 10);
    }
    expect(embedding.vectors[2]).toEqual(embedding.vectors[0]);
    expect(embedding.vectors[1]).not.toEqual(embedding.vectors[0]);
    expect(embedding.inputTokens).toBeGreaterThan(0);
    expect(f.governance.recorded).toEqual([
      expect.objectContaining({
        providerId: "local",
        model: "local-model",
        bindingId: "embedding",
        attribution: expect.objectContaining({ kind: "system", purpose: "knowledge_embedding" }),
        inputTokens: embedding.inputTokens,
        outputTokens: 0,
        totalTokens: embedding.inputTokens
      })
    ]);
  });

  it("makes no call and records nothing when there is nothing to embed", async () => {
    const f = await fixture();

    expect(await f.gateway.embed(embedCall([]))).toEqual({ vectors: [], inputTokens: 0 });

    expect(f.requests).toEqual([]);
    expect(f.governance.admitted).toBe(0);
  });

  it("sends the texts, the model and the binding's dimensions to the adapter in one request", async () => {
    const f = await fixture();

    await f.gateway.embed(embedCall(["eins", "zwei"]));

    expect(f.requests).toEqual([
      expect.objectContaining({ model: "local-model", texts: ["eins", "zwei"], dimensions: 8 })
    ]);
  });

  it("refuses an embedding call on a chat binding and a chat call on an embedding binding", async () => {
    const f = await fixture();

    await expect(
      f.gateway.embed({ ...embedCall(["text"]), binding: { bindingId: "chat" } })
    ).rejects.toThrow("Model binding 'chat' is no embedding binding and embeds nothing");
    await expect(
      f.gateway.complete({
        binding: { bindingId: "embedding" },
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        attribution: { kind: "system", purpose: "conversation_title" },
        clientInstanceId,
        correlationId: "corr-chat"
      })
    ).rejects.toThrow("Model binding 'embedding' is an embedding binding and answers no chat call");
    expect(f.requests).toEqual([]);
    expect(f.governance.admitted).toBe(0);
  });

  it("refuses a batch above the cap before admission", async () => {
    const f = await fixture();
    const texts = Array.from({ length: MODEL_EMBEDDING_MAX_TEXTS_PER_CALL + 1 }, () => "x");

    await expect(f.gateway.embed(embedCall(texts))).rejects.toMatchObject({
      code: "VALIDATION_FAILED"
    });
    expect(f.governance.admitted).toBe(0);
  });

  it("refuses at creation an embedding binding on a provider that does not embed", () => {
    const { embed: _embed, ...chatOnly } = scriptedAdapter(() => {
      throw new Error("never called");
    }).adapter;

    expect(() =>
      createModelGateway({
        providers: [provider],
        bindings,
        adapters: new Map([["local", chatOnly]]),
        governance: createRecordingGovernance(),
        logger: silentTestLogger
      })
    ).toThrow("Embedding binding 'embedding' is on model provider 'local', which does not embed");
  });

  it("fails an answer without one vector of the binding's length per text, and settles what was billed", async () => {
    const f = await fixture({
      answer: (request) => ({
        vectors: request.texts.map(() => [1, 0, 0]),
        usage: { inputTokens: 7, outputTokens: 0, totalTokens: 7, source: "provider_reported" }
      })
    });

    await expect(f.gateway.embed(embedCall(["a", "b"]))).rejects.toMatchObject({
      kind: "invalid_response"
    });

    expect(f.requests).toHaveLength(1);
    expect(f.governance.recorded).toEqual([expect.objectContaining({ inputTokens: 7 })]);
    expect(f.governance.settled).toBe(1);
  });

  it("sends the batch again after a server error and settles the call once", async () => {
    let attempts = 0;
    const f = await fixture({
      answer: (request) => {
        attempts += 1;
        if (attempts === 1) {
          throw new ModelProviderError({
            kind: "server_error",
            status: 503,
            message: "Model provider request failed"
          });
        }
        return unitAnswer(request);
      }
    });
    vi.useFakeTimers();

    const embedding = await advanceFakeClockUntilSettled(
      f.gateway.embed(embedCall(["a"])),
      RETRY_CLOCK_STEP_MS
    );

    expect(embedding.vectors).toHaveLength(1);
    expect(f.requests).toHaveLength(2);
    expect(f.governance.admitted).toBe(1);
    expect(f.governance.settled).toBe(1);
  });
});

describe("usage of an embedding call", () => {
  it("records the purpose, the binding, the tokens and the cost of the input", async () => {
    const store = (await createTestInstance()).stores;
    const usageGovernance = () =>
      new ModelUsageGovernance({
        store: store.usage,
        budget: { monthlySpendLimit: 10 },
        safeguards: {},
        costs: {
          customer: {
            id: "rates",
            version: "1",
            currency: "EUR",
            models: [
              {
                providerId: "local",
                model: "local-model",
                uncachedInputPricePerMillionTokens: 2,
                cachedInputPricePerMillionTokens: 0,
                outputPricePerMillionTokens: 0
              }
            ],
            webSearch: []
          }
        }
      });
    const f = await fixture({
      governance: usageGovernance(),
      region: "eu",
      answer: (request) => ({
        ...unitAnswer(request),
        usage: { inputTokens: 500, outputTokens: 0, totalTokens: 500, source: "provider_reported" }
      })
    });

    await f.gateway.embed({
      ...embedCall(["Wie hoch ist die Miete?"]),
      attribution: { kind: "system", purpose: "knowledge_query", operationRunId: "oprun_search" }
    });

    expect(await store.usage.listModelUsageEvents({ clientInstanceId })).toEqual([
      expect.objectContaining({
        status: "settled",
        purpose: "knowledge_query",
        agentName: "knowledge_query",
        providerId: "local",
        model: "local-model",
        region: "eu",
        bindingId: "embedding",
        operationRunId: "oprun_search",
        inputTokens: 500,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalTokens: 500,
        source: "provider_reported",
        customerBillableCost: expect.objectContaining({
          status: "settled",
          totalCostMicros: 500 * 2
        })
      })
    ]);
  });
});

describe("openai-compatible embeddings", () => {
  it("posts the texts to the embeddings endpoint and reads the vectors in the order of the texts", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return Response.json({
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] }
        ],
        usage: { prompt_tokens: 9, total_tokens: 9 }
      });
    });
    const adapter = await azureAdapter();

    const answer = await adapter.embed?.({
      model: "emb",
      texts: ["first", "second"],
      dimensions: 2
    });

    expect(answer).toEqual({
      vectors: [
        [1, 0],
        [0, 1]
      ],
      usage: {
        inputTokens: 9,
        outputTokens: 0,
        totalTokens: 9,
        source: "provider_reported"
      }
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://resource.example.test/openai/v1/embeddings");
    expect(sent[0]?.init).toMatchObject({
      method: "POST",
      redirect: "manual",
      headers: expect.objectContaining({ "api-key": "azure-test-key" })
    });
    expect(JSON.parse(String(sent[0]?.init.body))).toEqual({
      model: "emb",
      input: ["first", "second"],
      dimensions: 2,
      encoding_format: "float"
    });
  });

  it.each([
    ["a missing vector", { data: [{ index: 0, embedding: [1, 0] }] }],
    [
      "an index twice",
      {
        data: [
          { index: 0, embedding: [1, 0] },
          { index: 0, embedding: [0, 1] }
        ]
      }
    ],
    [
      "a vector of text",
      {
        data: [
          { index: 0, embedding: "AAAA" },
          { index: 1, embedding: [] }
        ]
      }
    ],
    ["no list", { object: "list" }]
  ])("refuses an answer with %s", async (_case, body) => {
    vi.stubGlobal("fetch", async () => Response.json(body));
    const adapter = await azureAdapter();

    await expect(
      adapter.embed?.({ model: "emb", texts: ["first", "second"], dimensions: 2 })
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("settles the tokens the provider reported with an answer it refused", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        data: [{ index: 3, embedding: [1, 0] }],
        usage: { prompt_tokens: 5, total_tokens: 5 }
      })
    );
    const f = await fixture({ adapter: await azureAdapter() });

    await expect(f.gateway.embed(embedCall(["first"]))).rejects.toMatchObject({
      kind: "invalid_response"
    });

    expect(f.governance.settled).toBe(1);
    expect(f.governance.recorded).toEqual([
      expect.objectContaining({ inputTokens: 5, totalTokens: 5, source: "provider_reported" })
    ]);
  });

  it("reports a refusal for too many requests as a rate limit with the provider's pause", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json(
        { error: { code: "429", message: "slow down" } },
        { status: 429, headers: { "retry-after": "2" } }
      )
    );
    const adapter = await azureAdapter();

    await expect(
      adapter.embed?.({ model: "emb", texts: ["first"], dimensions: 2 })
    ).rejects.toMatchObject({ kind: "rate_limit", retryable: true, retryAfterMs: 2_000 });
  });
});

const provider: ModelProviderConfig = { id: "local", type: "fake", model: "local-model" };
const bindings: ModelBindingConfig[] = [
  { id: "chat", providerId: "local" },
  { id: "embedding", providerId: "local", kind: "embedding", dimensions: DIMENSIONS }
];

function embedCall(texts: string[]): ModelEmbeddingCall {
  return {
    binding: { bindingId: "embedding" },
    texts,
    attribution: { kind: "system", purpose: "knowledge_embedding" },
    clientInstanceId,
    correlationId: "corr-embed"
  };
}

function unitAnswer(request: ModelAdapterEmbeddingRequest): ModelAdapterEmbedding {
  return {
    vectors: request.texts.map(() => [
      1,
      ...Array.from({ length: request.dimensions - 1 }, () => 0)
    ]),
    usage: {
      inputTokens: request.texts.length,
      outputTokens: 0,
      totalTokens: request.texts.length,
      source: "provider_reported"
    }
  };
}

/** An adapter whose embedding answer the test scripts, with the requests it received. */
function scriptedAdapter(
  answer: (request: ModelAdapterEmbeddingRequest) => ModelAdapterEmbedding
): { adapter: ModelAdapter; requests: ModelAdapterEmbeddingRequest[] } {
  const requests: ModelAdapterEmbeddingRequest[] = [];
  return {
    requests,
    adapter: {
      capabilities: () => ALL_MODEL_CAPABILITIES,
      complete: () => Promise.reject(new Error("This adapter answers no chat call")),
      stream: () => {
        throw new Error("This adapter answers no chat call");
      },
      async embed(request) {
        requests.push(request);
        return answer(request);
      }
    }
  };
}

async function fixture(
  input: {
    adapter?: ModelAdapter;
    answer?: (request: ModelAdapterEmbeddingRequest) => ModelAdapterEmbedding;
    governance?: ModelCallGovernance;
    region?: "eu";
  } = {}
) {
  const scripted = scriptedAdapter(input.answer ?? unitAnswer);
  const governance = createRecordingGovernance();
  return {
    requests: scripted.requests,
    governance,
    gateway: createModelGateway({
      providers: [{ ...provider, ...(input.region ? { region: input.region } : {}) }],
      bindings,
      adapters: new Map([["local", input.adapter ?? scripted.adapter]]),
      governance: input.governance ?? governance,
      logger: silentTestLogger
    })
  };
}

async function deterministicAdapter(): Promise<ModelAdapter> {
  const factory = await createProvider(
    modelProviderDefinitions,
    "models",
    { path: "infrastructure.models.local", entry: { provider: "deterministic" } },
    { secrets: createFakeSecrets(), logger: silentTestLogger }
  );
  return factory(provider);
}

async function azureAdapter(): Promise<ModelAdapter> {
  const entry = {
    provider: "openai-compatible",
    region: "eu",
    model: "chat-deployment",
    baseUrl: "https://resource.example.test/openai/v1",
    credentialSecret: "AZURE_KEY",
    authMode: "api-key"
  };
  const factory = await createProvider(
    modelProviderDefinitions,
    "models",
    { path: "infrastructure.models.azure", entry },
    { secrets: createFakeSecrets({ AZURE_KEY: "azure-test-key" }), logger: silentTestLogger }
  );
  return factory({
    id: "azure",
    type: "openai-compatible",
    model: "chat-deployment",
    region: "eu"
  });
}
