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
  type ToolExecutionContext,
  type ToolExecutionRequest
} from "@vivd-catalyst/core";
import { createStaticConfigAssetSource } from "@vivd-catalyst/core/testing";
import { loadClientInstanceConfigFromFile } from "@vivd-catalyst/config-schema";
import {
  createReadSkillTool,
  InProcessToolExecution,
  ToolRegistry
} from "@vivd-catalyst/tool-execution";

const supportSkill = {
  name: "support_review",
  title: "Support Review",
  description: "Use when reviewing support case details.",
  content: "# Support Review\n\nCheck facts, gaps, and next questions."
};

describe("client skills", () => {
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

function createExecution(input: {
  agents: ReturnType<typeof agent>[];
  skills: typeof supportSkill[];
}) {
  const tool = createReadSkillTool({
    assetSource: createStaticConfigAssetSource(input)
  });
  return new InProcessToolExecution({
    registry: new ToolRegistry({ tools: [tool] }),
    getAgentToolNames() {
      return ["read_skill"];
    }
  });
}

function request(agentName: string, skillName: string): ToolExecutionRequest {
  return {
    toolName: "read_skill",
    toolCallId: asToolCallId(`toolcall_${agentName}_${skillName}`),
    agentRunId: asAgentRunId("run_1"),
    conversationId: asConversationId("conv_1"),
    agentName,
    input: { name: skillName }
  };
}

async function executeReadSkill(
  execution: InProcessToolExecution,
  toolRequest: ToolExecutionRequest
) {
  const context: ToolExecutionContext = {
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
  const decision = await execution.authorize(toolRequest, context);
  expect(decision.status).toBe("allowed");
  if (decision.status !== "allowed") {
    throw new Error("Expected read_skill tool authorization");
  }
  return execution.execute({ ...toolRequest, authorization: decision }, context);
}
