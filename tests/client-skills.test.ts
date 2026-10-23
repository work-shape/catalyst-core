import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  AppError,
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asToolCallId,
  type SkillConfig,
  type ToolExecutionContext,
  type ToolExecutionRequest,
  type ToolOperationRunner,
  type LocaleCode
} from "@work-shape/catalyst-core";
import { createStaticConfigAssetSource } from "./support/static-config-asset-source";
import { createTestToolRunner } from "./support/tool-runner";
import { loadClientInstanceConfigFromFile } from "@work-shape/catalyst-config-schema";
import { platformDocsSkill } from "@work-shape/catalyst-client-assembly";
import {
  createReadSkillTool,
  createSkillSourceVersion,
  ToolRegistry
} from "@work-shape/catalyst-tool-execution";

const supportSkill = {
  name: "support_review",
  title: "Support Review",
  description: "Use when reviewing support case details.",
  content: "# Support Review\n\nCheck facts, gaps, and next questions."
};

const packagedSkill: SkillConfig = {
  ...supportSkill,
  resources: [
    {
      path: "references/escalation.md",
      mediaType: "text/markdown",
      content: "# Escalation\n\nEscalate uncertain cases."
    },
    {
      path: "references/schema.json",
      mediaType: "application/json",
      content: '{"status":"reviewed"}'
    }
  ]
};

describe("client skills", () => {
  it.each(["de", "en"] as const)(
    "ACCEPT-FIX-13 C2: explains an unoffered skill read and recovery in %s",
    async (locale) => {
      const execution = createExecution({
        agents: [agent("allowed_agent", [])],
        skills: [supportSkill]
      });
      const result = await executeReadSkill(
        execution,
        request("allowed_agent", "support_review"),
        locale
      );
      expect(result).toMatchObject({
        status: "failed",
        error: {
          code: "not_allowed",
          message: expect.stringContaining(
            locale === "de"
              ? "Dieser Agent hat diesen Skill nicht"
              : "This agent does not have this skill"
          )
        }
      });
      if (result.status !== "failed") throw new Error("Expected skill refusal");
      // PR-382 L3: it says in plain words where the skill is changed, naming no tools.
      expect(result.error.message).toContain(
        locale === "de" ? "in Studio auf der Seite des Skills" : "in Studio on the skill's page"
      );
      expect(result.error.message).not.toMatch(/Werkzeug|tool|read_skill|platform\./u);
      expect(result.error.message).toContain(
        locale === "de" ? "Es wurde nichts geändert" : "Nothing was changed"
      );
    }
  );
  it("rejects legacy agent and skill config-file keys with migration guidance", async () => {
    const root = await mkdtemp(join(tmpdir(), "vivd-catalyst-skills-"));
    await mkdir(join(root, "config"));
    await writeFile(
      join(root, "config", "app.yaml"),
      [
        "version: 1",
        "clientInstance:",
        "  id: test-client",
        "  displayName: Test Client",
        "  environment: development",
        "agentFiles:",
        "  - ../agents/*.agent.yaml",
        ""
      ].join("\n"),
      "utf8"
    );

    try {
      await loadClientInstanceConfigFromFile(join(root, "config", "app.yaml"));
      throw new Error("Expected legacy config assets to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      if (!(error instanceof AppError)) {
        throw error;
      }
      expect(error.code).toBe("VALIDATION_FAILED");
      expect(JSON.stringify(error.details)).toContain("platform asset store");
      expect(JSON.stringify(error.details)).toContain("catalyst config push");
    }
  });

  it("denies skills outside the active agent allow-list", async () => {
    const execution = createExecution({
      agents: [agent("allowed_agent", [])],
      skills: [supportSkill]
    });

    const result = await executeReadSkill(execution, request("allowed_agent", "support_review"));

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "not_allowed" }
    });
  });

  it("refuses the platform documentation when the agent has no offer of it", async () => {
    const execution = createExecution({
      agents: [agent("test_agent", [])],
      skills: [{ ...platformDocsSkill, resources: [...(platformDocsSkill.resources ?? [])] }]
    });
    const result = await executeReadSkill(execution, request("test_agent", "platform-docs"));
    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "not_allowed",
        message: expect.stringContaining("This agent does not have this skill")
      }
    });
  });

  it("reports an allowed but unknown skill", async () => {
    const execution = createExecution({
      agents: [agent("allowed_agent", ["missing_skill"])],
      skills: []
    });

    const result = await executeReadSkill(execution, request("allowed_agent", "missing_skill"));

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "validation_failed", message: "Skill 'missing_skill' is not defined" }
    });
  });

  it("reads an allowed skill with its source version", async () => {
    const execution = createExecution({
      agents: [agent("allowed_agent", ["support_review"])],
      skills: [supportSkill]
    });

    const result = await executeReadSkill(execution, request("allowed_agent", "support_review"));

    expect(result).toMatchObject({
      status: "success",
      output: {
        name: "support_review",
        title: "Support Review",
        content: "# Support Review\n\nCheck facts, gaps, and next questions.",
        sourceVersion: expect.stringMatching(/^sha256:/u)
      }
    });
  });

  it.each([false, true])("lists workspace files, with workspace access %s", async (workspace) => {
    const files = [
      { path: "scripts/fill.py", sha256: "a".repeat(64), bytes: 24, mediaType: "text/x-python" },
      { path: "assets/t.pdf", sha256: "b".repeat(64), bytes: 80, mediaType: "application/pdf" }
    ];
    const execution = createExecution({
      agents: [
        {
          ...agent("allowed_agent", [supportSkill.name]),
          toolNames: ["read_skill", ...(workspace ? ["workspace.exec"] : [])]
        }
      ],
      skills: [{ ...packagedSkill, files }]
    });
    const root = await executeReadSkill(execution, request("allowed_agent", supportSkill.name));
    expect(root).toMatchObject({
      status: "success",
      output: {
        content: supportSkill.content,
        resources: packagedSkill.resources?.map(({ path, mediaType }) => ({ path, mediaType })),
        files: [
          { path: "assets/t.pdf", mediaType: "application/pdf", bytes: 80, opensIn: "workspace" },
          { path: "scripts/fill.py", mediaType: "text/x-python", bytes: 24, opensIn: "workspace" }
        ]
      }
    });
    if (root.status !== "success") throw new Error("Expected root read");
    if (workspace) expect(root.output).not.toHaveProperty("workspaceNotice");
    else
      expect(root.output.workspaceNotice).toBe(
        "These files need a workspace that this agent does not have."
      );
    // Every command of a run with a workspace finds the whole folder there, read-only.
    if (workspace) expect(root.output.folder).toBe(`/skills/${supportSkill.name}/`);
    else expect(root.output).not.toHaveProperty("folder");
    const selected = await executeReadSkill(
      execution,
      request("allowed_agent", supportSkill.name, "assets/t.pdf")
    );
    expect(selected).toMatchObject({
      status: "failed",
      error: {
        code: "validation_failed",
        message: "The skill file 'assets/t.pdf' is used in the workspace.",
        details: { reason: "skill_file_in_workspace", path: "assets/t.pdf" }
      }
    });
    expect(selected).not.toHaveProperty("output");
    expect(JSON.stringify(selected)).not.toContain("content");
  });

  it("keeps the fixed text-only version and hashes paths and hashes of sorted files", () => {
    expect(createSkillSourceVersion(packagedSkill)).toBe(
      "sha256:35a728c57d7e5768fb59831aa75cb21b22c661f34239b793dbe7f6ec208f38e7"
    );
    expect(createSkillSourceVersion({ ...packagedSkill, files: [] })).toBe(
      createSkillSourceVersion(packagedSkill)
    );
    const files = [
      { path: "scripts/fill.py", sha256: "a".repeat(64), bytes: 24, mediaType: "text/x-python" },
      { path: "assets/t.pdf", sha256: "b".repeat(64), bytes: 80, mediaType: "application/pdf" }
    ];
    const version = createSkillSourceVersion({ ...packagedSkill, files });
    expect(createSkillSourceVersion({ ...packagedSkill, files: [...files].reverse() })).toBe(
      version
    );
    expect(
      createSkillSourceVersion({
        ...packagedSkill,
        files: files.map((file) => ({ ...file, bytes: 99, mediaType: "different" }))
      })
    ).toBe(version);
    expect(
      createSkillSourceVersion({
        ...packagedSkill,
        files: files.map((file) =>
          file.path === "assets/t.pdf" ? { ...file, sha256: "c".repeat(64) } : file
        )
      })
    ).not.toBe(version);
  });

  it("lists packaged resources and selectively reads one exact resource", async () => {
    const execution = createExecution({
      agents: [agent("allowed_agent", ["support_review"])],
      skills: [packagedSkill]
    });

    const root = await executeReadSkill(execution, request("allowed_agent", "support_review"));
    expect(root).toMatchObject({
      status: "success",
      output: {
        content: supportSkill.content,
        resources: [
          { path: "references/escalation.md", mediaType: "text/markdown" },
          { path: "references/schema.json", mediaType: "application/json" }
        ]
      }
    });
    const sourceVersion =
      root.status === "success" && typeof root.output.sourceVersion === "string"
        ? root.output.sourceVersion
        : undefined;

    const selected = await executeReadSkill(
      execution,
      request("allowed_agent", "support_review", "references/escalation.md")
    );
    expect(selected).toMatchObject({
      status: "success",
      output: {
        name: "support_review",
        resourcePath: "references/escalation.md",
        mediaType: "text/markdown",
        content: "# Escalation\n\nEscalate uncertain cases.",
        sourceVersion
      }
    });
    expect(selected.status === "success" ? selected.output : {}).not.toHaveProperty("resources");
    expect(selected.status === "success" ? selected.output : {}).not.toHaveProperty("title");

    const changedExecution = createExecution({
      agents: [agent("allowed_agent", ["support_review"])],
      skills: [
        {
          ...packagedSkill,
          resources: packagedSkill.resources?.map((resource) =>
            resource.path === "references/escalation.md"
              ? { ...resource, content: `${resource.content}\nChanged.` }
              : resource
          )
        }
      ]
    });
    const changed = await executeReadSkill(
      changedExecution,
      request("allowed_agent", "support_review")
    );
    expect(changed.status === "success" ? changed.output.sourceVersion : undefined).not.toBe(
      sourceVersion
    );
  });

  it("rejects unknown and traversing resource paths", async () => {
    const execution = createExecution({
      agents: [agent("allowed_agent", ["support_review"])],
      skills: [packagedSkill]
    });

    const unknown = await executeReadSkill(
      execution,
      request("allowed_agent", "support_review", "references/missing.md")
    );
    expect(unknown).toMatchObject({ status: "failed", error: { code: "validation_failed" } });

    const traversal = await executeReadSkill(
      execution,
      request("allowed_agent", "support_review", "../secret.md")
    );
    expect(traversal).toMatchObject({ status: "failed", error: { code: "validation_failed" } });
  });
});

function agent(name: string, skillNames: string[]) {
  return {
    name,
    displayName: "Allowed Agent",
    instructions: "Help with support work.",
    toolNames: ["read_skill"],
    skillNames,
    initialPrompts: []
  };
}

function createExecution(input: { agents: ReturnType<typeof agent>[]; skills: SkillConfig[] }) {
  const tool = createReadSkillTool({
    assetSource: createStaticConfigAssetSource(input)
  });
  return createTestToolRunner({
    registry: new ToolRegistry({ tools: [tool] }),
    getAgentToolNames() {
      return ["read_skill"];
    }
  });
}

function request(
  agentName: string,
  skillName: string,
  resourcePath?: string
): ToolExecutionRequest {
  return {
    toolName: "read_skill",
    toolCallId: asToolCallId(`toolcall_${agentName}_${skillName}`),
    agentRunId: asAgentRunId("run_1"),
    conversationId: asConversationId("conv_1"),
    agentName,
    input: { name: skillName, ...(resourcePath ? { resourcePath } : {}) }
  };
}

async function executeReadSkill(
  execution: ToolOperationRunner,
  toolRequest: ToolExecutionRequest,
  locale: LocaleCode = "en"
) {
  const context: ToolExecutionContext = {
    locale,
    clientInstanceId: asClientInstanceId("test-client"),
    correlationId: "corr_test",
    user: {
      id: "user-1",
      externalUserId: "user-1",
      displayLabel: "User",
      roles: ["user"],
      permissionRefs: [],
      clientInstanceId: asClientInstanceId("test-client"),
      authSource: "test"
    }
  };
  const result = await execution(toolRequest, context);
  if (result.status !== "success") return result;
  if (!isRecord(result.output)) {
    throw new Error("Expected read_skill to return an object");
  }
  return { ...result, output: result.output };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
