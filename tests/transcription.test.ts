import { afterEach, describe, expect, it, vi } from "vitest";
import {
  asClientInstanceId,
  asUserId,
  createProvider,
  StoreBackedAuditRecorder,
  type ModelBindingConfig,
  type ModelProviderConfig,
  type UsageRateCardTranscriptionConfig
} from "@work-shape/catalyst-core";
import { parseClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import {
  createModelGateway,
  modelProviderDefinitions,
  type ModelAdapter,
  type ModelAdapterTranscription,
  type ModelAdapterTranscriptionRequest,
  type ModelCallGovernance,
  type ModelTranscriptionCall
} from "@work-shape/catalyst-model-provider";
import { ModelUsageGovernance } from "@work-shape/catalyst-usage-governance";
import { createMultipartFilePayload } from "./support/chat-server-attachment-harness";
import { createFakeSecrets, createTestConfig } from "./support/fixtures";
import {
  ALL_MODEL_CAPABILITIES,
  createRecordingGovernance,
  silentTestLogger
} from "./support/model-gateway";
import { createTestInstance, createTestInstanceWith } from "./support/test-instance";

const clientInstanceId = asClientInstanceId("client-transcription");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("transcription binding in release config", () => {
  const releaseConfig = (overrides: Record<string, unknown> = {}) => ({
    clientInstance: { id: "transcription-config", displayName: "Transcription config" },
    infrastructure: {
      models: {
        local: { provider: "deterministic" },
        speech: {
          provider: "openai-compatible",
          region: "eu",
          model: "voxtral-mini-latest",
          baseUrl: "https://speech.example.test/v1",
          credentialSecret: "SPEECH_KEY",
          authMode: "bearer"
        },
        us: { provider: "openai-compatible", region: "global", model: "whisper" }
      }
    },
    modelBindings: [
      { id: "chat", providerId: "local" },
      { id: "speech", providerId: "speech", kind: "transcription" }
    ],
    ...overrides
  });

  it("reads a transcription binding, offers it to no agent and turns speech to text on", () => {
    const config = parseClientInstanceConfig(
      releaseConfig({ transcription: { terms: ["Grundbuch"] } })
    );

    expect(config.modelBindings[1]).toEqual(
      expect.objectContaining({ id: "speech", kind: "transcription", agentSelectable: false })
    );
    expect(config.transcription).toEqual({ terms: ["Grundbuch"] });
  });

  it("is off without a transcription binding", () => {
    const config = parseClientInstanceConfig(
      releaseConfig({ modelBindings: [{ id: "chat", providerId: "local" }] })
    );

    expect(config.transcription).toEqual({ terms: [] });
  });

  it.each([
    [
      "a provider outside the EU",
      { modelBindings: [{ id: "speech", providerId: "us", kind: "transcription" }] },
      /region 'eu'/u
    ],
    [
      "a provider without a region",
      { modelBindings: [{ id: "speech", providerId: "local", kind: "transcription" }] },
      /region 'eu'/u
    ],
    [
      "a second transcription binding",
      {
        modelBindings: [
          { id: "speech", providerId: "speech", kind: "transcription" },
          { id: "speech-2", providerId: "speech", kind: "transcription" }
        ]
      },
      /at most one/u
    ],
    [
      "a chat fallback that names it",
      {
        modelBindings: [
          { id: "chat", providerId: "local", fallback: "speech" },
          { id: "speech", providerId: "speech", kind: "transcription" }
        ]
      },
      /speech/u
    ]
  ])("refuses %s", (_case, overrides, message) => {
    expect(() => parseClientInstanceConfig(releaseConfig(overrides))).toThrow(message);
  });

  it("asks for a price per audio minute where a spend budget is set", () => {
    const usage = (transcription: unknown[]) => ({
      usage: {
        budget: { monthlySpendLimit: 10 },
        costs: {
          customer: {
            id: "rates",
            version: "1",
            currency: "EUR",
            models: [
              {
                providerId: "local",
                model: "local",
                uncachedInputPricePerMillionTokens: 0,
                cachedInputPricePerMillionTokens: 0,
                outputPricePerMillionTokens: 0
              }
            ],
            webSearch: [],
            transcription
          }
        }
      }
    });

    expect(() => parseClientInstanceConfig(releaseConfig(usage([])))).toThrow(/speech/u);
    expect(
      parseClientInstanceConfig(
        releaseConfig(
          usage([
            { providerId: "speech", model: "voxtral-mini-latest", pricePerAudioMinute: 0.003 }
          ])
        )
      ).usage.costs.customer?.transcription
    ).toEqual([{ providerId: "speech", model: "voxtral-mini-latest", pricePerAudioMinute: 0.003 }]);
  });
});

describe("gateway.transcribe", () => {
  it("sends the recording, the language and the terms, and settles the seconds", async () => {
    const f = fixture();

    const result = await f.gateway.transcribe(transcribeCall());

    expect(result).toEqual({ text: "Hallo Welt", durationSeconds: 12 });
    expect(f.requests).toEqual([
      expect.objectContaining({
        model: "voxtral-mini-latest",
        language: "de",
        terms: ["Grundbuch"],
        audio: expect.objectContaining({ mimeType: "audio/webm", filename: "recording.webm" })
      })
    ]);
    expect(f.governance.admitted).toBe(1);
    expect(f.governance.settled).toBe(1);
    expect(f.governance.recorded).toEqual([
      expect.objectContaining({
        providerId: "speech",
        model: "voxtral-mini-latest",
        bindingId: "speech",
        attribution: expect.objectContaining({ kind: "system", purpose: "transcription" }),
        audio: { seconds: 12 }
      })
    ]);
  });

  it("refuses a transcription on a chat binding before admission", async () => {
    const f = fixture();

    await expect(
      f.gateway.transcribe({ ...transcribeCall(), binding: { bindingId: "chat" } })
    ).rejects.toThrow(/no transcription binding/u);
    expect(f.governance.admitted).toBe(0);
  });

  it("refuses at creation a transcription binding on a provider that does not transcribe", () => {
    const { adapter } = scriptedAdapter();
    const { transcribe: _transcribe, ...withoutTranscribe } = adapter;

    expect(() =>
      createModelGateway({
        providers,
        bindings,
        adapters: new Map([
          ["local", withoutTranscribe],
          ["speech", withoutTranscribe]
        ]),
        governance: createRecordingGovernance(),
        logger: silentTestLogger
      })
    ).toThrow(/does not transcribe/u);
  });
});

describe("usage of a transcription", () => {
  it("records the purpose, the seconds and the price per audio minute", async () => {
    const store = (await createTestInstance()).stores;
    const governance = new ModelUsageGovernance({
      store: store.usage,
      budget: { monthlySpendLimit: 10 },
      safeguards: {},
      costs: {
        customer: {
          id: "rates",
          version: "1",
          currency: "EUR",
          models: [],
          webSearch: [],
          transcription: [
            { providerId: "speech", model: "voxtral-mini-latest", pricePerAudioMinute: 0.006 }
          ]
        }
      }
    });
    const f = fixture({ governance, answer: () => answerOf("Hallo", 90) });

    await f.gateway.transcribe(transcribeCall());

    expect(await store.usage.listModelUsageEvents({ clientInstanceId })).toEqual([
      expect.objectContaining({
        status: "settled",
        purpose: "transcription",
        providerId: "speech",
        model: "voxtral-mini-latest",
        region: "eu",
        bindingId: "speech",
        audioSeconds: 90,
        customerBillableCost: expect.objectContaining({
          status: "settled",
          // A minute and a half at 0.006 EUR a minute.
          totalCostMicros: 9_000
        })
      })
    ]);
  });

  it("leaves a transcription without a rate unpriced, and one without seconds incomplete", async () => {
    const store = (await createTestInstance()).stores;
    const governance = (transcription: UsageRateCardTranscriptionConfig[]) =>
      new ModelUsageGovernance({
        store: store.usage,
        budget: {},
        safeguards: {},
        costs: {
          customer: {
            id: "rates",
            version: "1",
            currency: "EUR",
            models: [],
            webSearch: [],
            transcription
          }
        }
      });

    await fixture({ governance: governance([]) }).gateway.transcribe(transcribeCall());
    await fixture({
      governance: governance([
        { providerId: "speech", model: "voxtral-mini-latest", pricePerAudioMinute: 0.006 }
      ]),
      answer: () => ({ text: "Hallo", usage: noUsage })
    }).gateway.transcribe(transcribeCall());

    const events = await store.usage.listModelUsageEvents({ clientInstanceId });
    expect(events.map((event) => event.customerBillableCost?.status).sort()).toEqual([
      "incomplete",
      "unpriced"
    ]);
  });
});

describe("openai-compatible transcriptions", () => {
  it("posts the recording as multipart with each term as context bias and reads the seconds", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return Response.json({
        model: "voxtral-mini-latest",
        text: " Bitte den Grundbuchauszug prüfen. ",
        language: "de",
        usage: {
          prompt_audio_seconds: 4.2,
          prompt_tokens: 100,
          completion_tokens: 8,
          total_tokens: 108
        }
      });
    });
    const adapter = await speechAdapter();

    const answer = await adapter.transcribe?.({
      model: "voxtral-mini-latest",
      audio: {
        bytes: new TextEncoder().encode("audio"),
        mimeType: "audio/webm",
        filename: "recording.webm"
      },
      language: "de",
      terms: ["Grundbuch", "Notar"]
    });

    expect(answer).toEqual({
      text: "Bitte den Grundbuchauszug prüfen.",
      audioSeconds: 5,
      usage: {
        inputTokens: 100,
        outputTokens: 8,
        totalTokens: 108,
        source: "provider_reported"
      }
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://speech.example.test/v1/audio/transcriptions");
    const headers = new Headers(sent[0]?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer speech-test-key");
    // The form sets its own content type, with the boundary.
    expect(headers.has("content-type")).toBe(false);
    const form = sent[0]?.init.body;
    if (!(form instanceof FormData)) throw new Error("The request sent no form");
    expect(form.get("model")).toBe("voxtral-mini-latest");
    expect(form.get("language")).toBe("de");
    expect(form.getAll("context_bias")).toEqual(["Grundbuch", "Notar"]);
    const file = form.get("file");
    if (!(file instanceof File)) throw new Error("The form holds no file");
    expect(file.name).toBe("recording.webm");
    expect(file.type).toBe("audio/webm");
    expect(await file.text()).toBe("audio");
  });

  it("reads the seconds OpenAI counts, and refuses an answer without text", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ text: "Hi", usage: { seconds: 3 } }));
    const adapter = await speechAdapter();
    const request = {
      model: "whisper",
      audio: { bytes: new Uint8Array([1]), mimeType: "audio/mp4", filename: "recording.mp4" },
      terms: []
    };

    expect(await adapter.transcribe?.(request)).toEqual(
      expect.objectContaining({ text: "Hi", audioSeconds: 3 })
    );

    vi.stubGlobal("fetch", async () => Response.json({ transcript: "Hi" }));
    await expect(adapter.transcribe?.(request)).rejects.toThrow(/no transcription/u);
  });
});

describe("POST /api/v1/transcriptions", () => {
  const recording = (content = "Hallo Welt", contentType = "audio/webm;codecs=opus") =>
    createMultipartFilePayload({
      fieldName: "file",
      filename: "recording.webm",
      contentType,
      content
    });
  const speechConfig = () =>
    createTestConfig({
      modelProviders: [
        { id: "local", type: "deterministic", model: "local" },
        {
          id: "speech",
          type: "openai-compatible",
          model: "voxtral-mini-latest",
          baseUrl: "https://speech.example.test/v1",
          credentialSecret: "SPEECH_KEY",
          region: "eu"
        }
      ],
      modelBindings: [
        { id: "chat", providerId: "local" },
        { id: "speech", providerId: "speech", kind: "transcription" }
      ],
      transcription: { terms: ["Grundbuch", "grundbuch"] }
    });

  it("answers as not found where speech to text is off, and the config says it is off", async () => {
    const app = await createTestInstance();
    const upload = recording();
    const config = await app.call("config.get");
    expect(config.json<{ transcription?: unknown }>().transcription).toEqual({ enabled: false });

    const response = await app.call("transcriptions.create", {
      headers: upload.headers,
      payload: upload.payload
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns the text of a recording, sends the terms once each, and audits the seconds", async () => {
    const config = speechConfig();
    const app = await createTestInstanceWith((stores) => ({
      config,
      auditRecorder: new StoreBackedAuditRecorder({
        clientInstanceId: asClientInstanceId(config.clientInstance.id),
        store: stores.audit
      })
    }));
    const upload = recording();
    expect(
      (await app.call("config.get")).json<{ transcription?: unknown }>().transcription
    ).toEqual({ enabled: true });

    const response = await app.call("transcriptions.create", {
      headers: upload.headers,
      payload: upload.payload
    });

    expect(response.statusCode).toBe(200);
    // The fake transcribes the bytes as text and adds the terms it was sent in brackets: the
    // release's terms, each once.
    expect(response.json()).toEqual({ text: "Hallo Welt [Grundbuch]", durationSeconds: 10 });

    const audited = (
      await app.stores.audit.listAuditEvents({
        clientInstanceId: asClientInstanceId(config.clientInstance.id),
        limit: 50
      })
    ).filter((event) => event.type === "transcription.completed");
    expect(audited).toEqual([
      expect.objectContaining({
        status: "success",
        subject: "speech",
        metadata: { bindingId: "speech", durationSeconds: 10 }
      })
    ]);
    expect(JSON.stringify(audited)).not.toContain("Hallo");

    const usage = await app.stores.usage.listModelUsageEvents({
      clientInstanceId: asClientInstanceId(config.clientInstance.id)
    });
    expect(usage).toEqual([
      expect.objectContaining({ purpose: "transcription", bindingId: "speech", audioSeconds: 10 })
    ]);
  });

  it.each([
    ["a recording in no audio format", () => recording("Hallo", "text/plain"), 422],
    ["an empty recording", () => recording(""), 422]
  ])("refuses %s", async (_case, upload, status) => {
    const app = await createTestInstanceWith(() => ({ config: speechConfig() }));
    const { headers, payload } = upload();

    const response = await app.call("transcriptions.create", { headers, payload });

    expect(response.statusCode).toBe(status);
  });

  it("answers as not found for a chat the person may not reach", async () => {
    const app = await createTestInstanceWith(() => ({ config: speechConfig() }));
    const upload = recording();

    const response = await app.call("transcriptions.create", {
      query: { conversationId: "conv_missing" },
      headers: upload.headers,
      payload: upload.payload
    });

    expect(response.statusCode).toBe(404);
  });
});

const providers: ModelProviderConfig[] = [
  { id: "local", type: "deterministic", model: "local-model" },
  { id: "speech", type: "openai-compatible", model: "voxtral-mini-latest", region: "eu" }
];

const bindings: ModelBindingConfig[] = [
  { id: "chat", providerId: "local", agentSelectable: true, userSelectable: false },
  {
    id: "speech",
    providerId: "speech",
    kind: "transcription",
    agentSelectable: false,
    userSelectable: false
  }
];

const noUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  source: "provider_reported"
} as const;

function answerOf(text: string, seconds: number): ModelAdapterTranscription {
  return { text, audioSeconds: seconds, usage: noUsage };
}

function transcribeCall(): ModelTranscriptionCall {
  return {
    binding: { bindingId: "speech" },
    audio: {
      bytes: new TextEncoder().encode("audio"),
      mimeType: "audio/webm",
      filename: "recording.webm"
    },
    language: "de",
    terms: ["Grundbuch"],
    attribution: { kind: "system", purpose: "transcription", userId: asUserId("user-1") },
    clientInstanceId,
    correlationId: "corr-transcription"
  };
}

/** An adapter whose transcription the test scripts, with the requests it received. */
function scriptedAdapter(
  answer: (request: ModelAdapterTranscriptionRequest) => ModelAdapterTranscription = () =>
    answerOf("Hallo Welt", 12)
): { adapter: ModelAdapter; requests: ModelAdapterTranscriptionRequest[] } {
  const requests: ModelAdapterTranscriptionRequest[] = [];
  return {
    requests,
    adapter: {
      capabilities: () => ALL_MODEL_CAPABILITIES,
      complete: () => Promise.reject(new Error("This adapter answers no chat call")),
      stream: () => {
        throw new Error("This adapter answers no chat call");
      },
      async transcribe(request) {
        requests.push(request);
        return answer(request);
      }
    }
  };
}

function fixture(
  input: {
    answer?: (request: ModelAdapterTranscriptionRequest) => ModelAdapterTranscription;
    governance?: ModelCallGovernance;
  } = {}
) {
  const scripted = scriptedAdapter(input.answer);
  const governance = createRecordingGovernance();
  return {
    requests: scripted.requests,
    governance,
    gateway: createModelGateway({
      providers,
      bindings,
      adapters: new Map([
        ["local", scripted.adapter],
        ["speech", scripted.adapter]
      ]),
      governance: input.governance ?? governance,
      logger: silentTestLogger
    })
  };
}

async function speechAdapter(): Promise<ModelAdapter> {
  const entry = {
    provider: "openai-compatible",
    region: "eu",
    model: "voxtral-mini-latest",
    baseUrl: "https://speech.example.test/v1",
    credentialSecret: "SPEECH_KEY",
    authMode: "bearer"
  };
  const factory = await createProvider(
    modelProviderDefinitions,
    "models",
    { path: "infrastructure.models.speech", entry },
    { secrets: createFakeSecrets({ SPEECH_KEY: "speech-test-key" }), logger: silentTestLogger }
  );
  return factory({
    id: "speech",
    type: "openai-compatible",
    model: "voxtral-mini-latest",
    region: "eu"
  });
}
