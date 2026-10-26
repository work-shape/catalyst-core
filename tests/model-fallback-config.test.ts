import { describe, expect, it } from "vitest";
import { parseClientInstanceConfig } from "@work-shape/catalyst-config-schema";

const releaseConfig = (modelBindings: Record<string, unknown>[]) => ({
  clientInstance: { id: "fallback-config", displayName: "Fallback config" },
  infrastructure: {
    models: {
      eu: {
        provider: "openai-compatible",
        region: "eu",
        model: "chat-deployment",
        baseUrl: "https://resource.example.test/openai/v1",
        credentialSecret: "EU_KEY",
        authMode: "api-key"
      },
      us: {
        provider: "openai-compatible",
        region: "global",
        model: "chat-model",
        baseUrl: "https://api.example.test/v1",
        credentialSecret: "US_KEY"
      }
    }
  },
  modelBindings
});

describe("a model binding's fallback in release config", () => {
  it("accepts two chat bindings of one region that name each other", () => {
    const config = parseClientInstanceConfig(
      releaseConfig([
        { id: "primary", providerId: "eu", model: "model-a", fallback: "second" },
        { id: "second", providerId: "eu", model: "model-b", fallback: "primary" }
      ])
    );

    expect(config.modelBindings.map((binding) => [binding.id, binding.fallback])).toEqual([
      ["primary", "second"],
      ["second", "primary"]
    ]);
  });

  it.each([
    [
      "itself",
      [{ id: "primary", providerId: "eu", fallback: "primary" }],
      "names itself as its fallback"
    ],
    [
      "a binding that does not exist",
      [{ id: "primary", providerId: "eu", fallback: "gone" }],
      "names missing model binding 'gone' as its fallback"
    ],
    [
      "an embedding binding",
      [
        { id: "primary", providerId: "eu", fallback: "vectors" },
        { id: "vectors", providerId: "eu", kind: "embedding", dimensions: 8 }
      ],
      "names embedding binding 'vectors' as its fallback"
    ],
    [
      "a binding in another region",
      [
        { id: "primary", providerId: "eu", fallback: "abroad" },
        { id: "abroad", providerId: "us" }
      ],
      "runs in region 'eu', but its fallback 'abroad' runs in region 'global'"
    ]
  ])("refuses a fallback that is %s", (_name, bindings, message) => {
    expect(() => parseClientInstanceConfig(releaseConfig(bindings))).toThrow(message);
  });

  it("refuses a fallback on an embedding binding", () => {
    expect(() =>
      parseClientInstanceConfig(
        releaseConfig([
          { id: "chat", providerId: "eu" },
          { id: "vectors", providerId: "eu", kind: "embedding", dimensions: 8, fallback: "chat" }
        ])
      )
    ).toThrow();
  });
});
