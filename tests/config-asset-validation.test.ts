import { describe, expect, it } from "vitest";
import { AppError } from "@vivd-catalyst/core";
import { validateConfigAssetBundle } from "@vivd-catalyst/config-schema";

describe("config asset bundle validation", () => {
  it("parses a valid agent and skill bundle", () => {
    const researchSkill = {
      ...skill(),
      resources: [
        {
          path: "references/sources.md",
          mediaType: "text/markdown",
          content: "# Sources"
        }
      ]
    };
    const result = validateConfigAssetBundle({
      agents: [agent({ skillNames: ["research"], toolNames: ["search", "read_skill"] })],
      skills: [researchSkill],
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
    expect(result.skills).toEqual([researchSkill]);
  });

  it.each([
    {
      instructions: "Help.\nUse `page.save_as_app`.",
      toolNames: [],
      issue:
        "Agent 'assistant' references unavailable tool 'page.save_as_app' in instructions line 2"
    },
    {
      instructions: "Help.",
      toolNames: ["page.save_as_app"],
      issue: "Agent 'assistant' references unavailable tool 'page.save_as_app' in toolNames[0]"
    }
  ])("locates an unavailable explicit tool reference", ({ instructions, toolNames, issue }) => {
    expect(
      issueMessages(
        validationError({
          agents: [agent({ instructions, toolNames })],
          skills: [],
          defaultAgentName: "assistant",
          refs: refs()
        })
      )
    ).toContain(issue);
  });

  it.each([
    "Use page.missing, (page.missing); page.missing!",
    "Use `page.missing()`.",
    "```text\npage.missing\n```"
  ])("checks dotted tokens with punctuation and in code: %s", (instructions) => {
    expect(
      issueMessages(
        validationError({
          agents: [agent({ instructions })],
          skills: [],
          defaultAgentName: "assistant",
          refs: refs()
        })
      )
    ).toContainEqual(
      expect.stringContaining("unavailable tool 'page.missing' in instructions line")
    );
  });

  it("accepts enabled instruction tools without requiring them in toolNames", () => {
    expect(() =>
      validateConfigAssetBundle({
        agents: [
          agent({ instructions: "Use `page.save_as_app()` and `connection.crm.getRecord`." })
        ],
        skills: [],
        defaultAgentName: "assistant",
        refs: { ...refs(), enabledToolNames: ["page.save_as_app", "connection.crm.getRecord"] }
      })
    ).not.toThrow();
  });

  it("ignores non-tool namespaces, paths, URLs, emails, filenames and domain endings", () => {
    expect(() =>
      validateConfigAssetBundle({
        agents: [
          agent({
            instructions: [
              "ordinary.prose is prose, as is page.com.",
              "Read `config.yaml`, `report.pdf`, `src/main.ts`, `https://example.com` and `toolNames`.",
              "A pattern `page.*` is not an identifier; page.md and page.example.de are files or domains.",
              "Read /page.missing, ./page.missing, C:\\page.missing, page.missing/path and person@page.missing.",
              "Visit https://page.missing, https://example.com/page.missing and www.page.missing.",
              "```ts",
              "const name = `ordinary.prose`;",
              "```",
              "Use `search` and `read_skill`."
            ].join("\n")
          })
        ],
        skills: [],
        defaultAgentName: "assistant",
        refs: refs()
      })
    ).not.toThrow();
  });

  it("does not scan skills for tool names", () => {
    expect(() =>
      validateConfigAssetBundle({
        agents: [agent()],
        skills: [{ ...skill(), content: "Use page.missing and connection.absent.lookup." }],
        defaultAgentName: "assistant",
        refs: refs()
      })
    ).not.toThrow();
  });

  it.each([
    {
      label: "traversal",
      resources: [{ path: "../secret.md", mediaType: "text/markdown", content: "no" }],
      issue: /normalized relative path/u
    },
    {
      label: "absolute paths",
      resources: [{ path: "/secret.md", mediaType: "text/markdown", content: "no" }],
      issue: /normalized relative path/u
    },
    {
      label: "Windows drive paths",
      resources: [{ path: "C:/outside.md", mediaType: "text/markdown", content: "no" }],
      issue: /normalized relative path/u
    },
    {
      label: "control characters",
      resources: [
        { path: "references/secret\u0001.md", mediaType: "text/markdown", content: "no" }
      ],
      issue: /normalized relative path/u
    },
    {
      label: "duplicate paths",
      resources: [
        { path: "references/a.md", mediaType: "text/markdown", content: "one" },
        { path: "references/a.md", mediaType: "text/markdown", content: "two" }
      ],
      issue: /Duplicate skill resource path/u
    },
    {
      label: "unsupported media types",
      resources: [{ path: "references/a.html", mediaType: "text/html", content: "no" }],
      issue: /Invalid option/u
    }
  ])("rejects skill resource $label", ({ resources, issue }) => {
    const error = validationError({
      agents: [],
      skills: [{ ...skill(), resources }],
      refs: refs()
    });
    expect(issueMessages(error)).toEqual(expect.arrayContaining([expect.stringMatching(issue)]));
  });

  // An asset's id is the last segment of its address, and a browser drops `.` and `..`.
  it.each([".", ".."])("refuses the name %j for an agent and for a skill", (name) => {
    const error = validationError({
      agents: [agent({ name })],
      skills: [{ ...skill(), name }],
      defaultAgentName: name,
      refs: refs()
    });

    expect(issueMessages(error)).toEqual(
      expect.arrayContaining([
        "Agent name must not be '.' or '..'",
        expect.stringMatching(/Skill name must start with a letter/u)
      ])
    );
  });

  it("keeps a dot inside an agent name", () => {
    const result = validateConfigAssetBundle({
      agents: [agent({ name: "sales.v2" }), agent({ name: "..." })],
      skills: [],
      defaultAgentName: "sales.v2",
      refs: refs()
    });

    expect(result.agents.map((entry) => entry.name)).toEqual(["sales.v2", "..."]);
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
    expect(issueMessages(validationError(input))).toEqual(
      expect.arrayContaining([expect.stringMatching(issue)])
    );
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
    fastModeModelBindingIds: [],
    enabledToolNames: ["search", "read_skill", "page.save"]
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
