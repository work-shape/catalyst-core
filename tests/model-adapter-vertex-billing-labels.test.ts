import { afterEach, describe, expect, it, vi } from "vitest";
import { createProvider } from "@vivd-catalyst/core";
import { modelProviderDefinitions, type ModelAdapterFactory } from "@vivd-catalyst/model-provider";
import {
  loadModelAdapterRecording,
  replayModelAdapterRecording,
  replayServiceAccountKey
} from "./support/model-adapter-recordings";
import { silentTestLogger } from "./support/model-gateway";

async function adapter(labels?: Record<string, string>) {
  const factory = await createProvider<"models", ModelAdapterFactory>(
    modelProviderDefinitions,
    "models",
    {
      path: "infrastructure.models.vertex",
      entry: {
        provider: "google-vertex",
        region: "eu",
        model: "recorded-gemini-model",
        projectId: "recorded-project",
        credentialSecret: "VERTEX_KEY",
        ...(labels ? { labels } : {})
      }
    },
    { secrets: { resolve: async () => replayServiceAccountKey() }, logger: silentTestLogger }
  );
  return factory({
    id: "vertex",
    type: "google-vertex",
    region: "eu",
    model: "recorded-gemini-model"
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("Vertex billing attribution", () => {
  it.each([false, true])("sends operator labels for streaming=%s", async (streaming) => {
    const labels = { instance: "customer-demo", environment: "demo" };
    const recording = loadModelAdapterRecording(
      "google-vertex",
      streaming ? "text-stream" : "text"
    );
    for (const exchange of recording.exchanges) {
      exchange.request.body = Object.assign({}, exchange.request.body, { labels });
    }
    const requests = replayModelAdapterRecording(recording);
    const provider = await adapter(labels);
    const request = {
      model: "recorded-gemini-model",
      messages: [
        ...(!streaming ? [{ role: "system" as const, content: "Answer briefly." }] : []),
        { role: "user" as const, content: "Say hello." }
      ],
      tools: []
    };
    if (streaming) {
      for await (const event of provider.stream(request)) {
        if (event.type === "completed") expect(event.completion.text).toBeTruthy();
      }
    } else {
      expect((await provider.complete(request)).text).toBeTruthy();
    }
    expect(requests.count()).toBe(1);
  });

  it.each([
    { "Invalid key": "demo" },
    { instance: "Customer Name" },
    { instance: "a".repeat(64) },
    Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`key${index}`, "demo"]))
  ])("rejects invalid billing labels", async (labels) => {
    await expect(adapter(labels)).rejects.toThrow();
  });
});
