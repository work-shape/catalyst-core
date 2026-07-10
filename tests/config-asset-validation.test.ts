import { describe, expect, it } from "vitest";
import { AppError } from "@vivd-catalyst/core";
import { validateConfigAssetBundle } from "@vivd-catalyst/config-schema";

describe("config asset bundle validation", () => {
  it("parses a valid agent and skill bundle", () => {
    const result = validateConfigAssetBundle({
      agents: [agent({ skillNames: ["research"], toolNames: ["search", "read_skill"] })],
      skills: [skill()],
      defaultAgentName: "assistant",
      refs: refs()
    });

    expect(result.agents).toMatchObject([
      {
        name: "assistant",
        modelProviderId: "provider-1",
        skillNames: ["research"],
        toolNames: ["search", "read_skill"],
        initialPrompts: []
      }
    ]);
    expect(result.skills).toEqual([skill()]);
  });

  it("aggregates zod issues with per-asset context", () => {
    const error = validationError({
      agents: [{ ...agent(), instructions: "" }],
      skills: [{ ...skill(), content: "" }],
      defaultAgentName: "assistant",
      refs: refs()
    });

    expect(error.details).toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ assetKind: "agent", assetName: "assistant", index: 0 }),
        expect.objectContaining({ assetKind: "skill", assetName: "research", index: 0 })
      ])
    });
  });

  it.each([
    {
      label: "duplicate agent names",
      input: {
        agents: [agent(), agent()],
        skills: [],
        defaultAgentName: "assistant",
        refs: refs()
      },
      issue: /Duplicate agent definitions: assistant/u
    },
    {
      label: "duplicate skill names",
      input: {
        agents: [agent({ skillNames: ["research"] })],
        skills: [skill(), skill()],
        defaultAgentName: "assistant",
        refs: refs()
      },
      issue: /Duplicate skill definitions: research/u
    },
    {
      label: "missing default for a non-empty agent bundle",
      input: { agents: [agent()], skills: [], refs: refs() },
      issue: /defaultAgentName must be set/u
    },
    {
      label: "unknown default agent",
      input: {
        agents: [agent()],
        skills: [],
        defaultAgentName: "missing",
        refs: refs()
      },
      issue: /Default agent 'missing' is not defined/u
    },
    {
      label: "a default for an empty agent bundle",
      input: { agents: [], skills: [], defaultAgentName: "assistant", refs: refs() },
      issue: /defaultAgentName must be unset/u
    },
    {
      label: "mutually exclusive model references",
      input: {
        agents: [agent({ modelBindingId: "binding-1" })],
        skills: [],
        defaultAgentName: "assistant",
        refs: refs()
      },
      issue: /either modelProviderId or modelBindingId/u
    },
    {
      label: "missing model providers",
      input: {
        agents: [agent({ modelProviderId: "missing" })],
        skills: [],
        defaultAgentName: "assistant",
        refs: refs()
      },
      issue: /missing model provider 'missing'/u
    },
    {
      label: "missing model bindings",
      input: {
        agents: [agent({ modelProviderId: undefined, modelBindingId: "missing" })],
        skills: [],
        defaultAgentName: "assistant",
        refs: refs()
      },
      issue: /missing model binding 'missing'/u
    },
    {
      label: "missing skills",
      input: {
        agents: [agent({ skillNames: ["missing"] })],
        skills: [],
        defaultAgentName: "assistant",
        refs: refs()
      },
      issue: /references missing skill 'missing'/u
    },
    {
      label: "tools outside the enabled set",
      input: {
        agents: [agent({ toolNames: ["disabled"] })],
        skills: [],
        defaultAgentName: "assistant",
        refs: refs()
      },
      issue: /references unavailable tool 'disabled'/u
    }
  ])("rejects $label", ({ input, issue }) => {
    expect(issueMessages(validationError(input))).toEqual(expect.arrayContaining([expect.stringMatching(issue)]));
  });
});

function agent(overrides: Record<string, unknown> = {}) {
  return {
    name: "assistant",
    displayName: "Assistant",
    instructions: "Help the user.",
    modelProviderId: "provider-1",
    toolNames: [],
    skillNames: [],
    ...overrides
  };
}

function skill() {
  return {
    name: "research",
    title: "Research",
    description: "Research carefully.",
    content: "Follow the research workflow."
  };
}

function refs() {
  return {
    modelProviderIds: ["provider-1"],
    modelBindingIds: ["binding-1"],
    enabledToolNames: ["search", "read_skill"]
  };
}

function validationError(input: Parameters<typeof validateConfigAssetBundle>[0]): AppError {
  try {
    validateConfigAssetBundle(input);
  } catch (error) {
    if (error instanceof AppError) {
      expect(error.code).toBe("VALIDATION_FAILED");
      return error;
    }
    throw error;
  }
  throw new Error("Expected config asset bundle validation to fail");
}

function issueMessages(error: AppError): string[] {
  const details = error.details as { issues?: Array<{ message?: unknown }> } | undefined;
  return (details?.issues ?? [])
    .map((issue) => issue.message)
    .filter((message): message is string => typeof message === "string");
}
