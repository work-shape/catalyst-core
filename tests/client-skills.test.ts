import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asToolCallId,
  type ToolExecutionContext
} from "@vivd-catalyst/core";
import { loadClientInstanceConfigFromFile } from "@vivd-catalyst/config-schema";
import {
  createReadSkillTool,
  InProcessToolExecution,
  SkillCatalog,
  ToolRegistry
} from "@vivd-catalyst/tool-execution";

describe("client skills", () => {
  it("loads Markdown skill files into release config and derives SKILL.md names", async () => {
    const root = await mkdtemp(join(tmpdir(), "vivd-catalyst-skills-"));
    await mkdir(join(root, "config"));
    await mkdir(join(root, "skills", "support-review"), { recursive: true });
    await writeFile(
      join(root, "skills", "support-review", "SKILL.md"),
      [
        "---",
        "title: Support Review",
        "description: Use when reviewing support case details.",
        "---",
        "",
        "# Support Review",
        "",
        "Check facts, gaps, and next questions.",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(root, "config", "app.yaml"),
      [
        "version: 1",
        "clientInstance:",
        "  id: test-client",
        "  displayName: Test Client",
        "  environment: development",
        "defaultAgentName: test_agent",
        "agents:",
        "  - name: test_agent",
        "    displayName: Test Agent",
        "    instructions: Help with support work.",
        "    toolNames:",
        "      - read_skill",
        "    skillNames:",
        "      - support_review",
        "skillFiles:",
        "  - ../skills/support-review/SKILL.md",
        "tools:",
        "  - name: read_skill",
        "    enabled: true",
        ""
      ].join("\n"),
      "utf8"
    );

    const config = await loadClientInstanceConfigFromFile(join(root, "config", "app.yaml"));

    expect(config.skills).toEqual([
      {
        name: "support_review",
        title: "Support Review",
        description: "Use when reviewing support case details.",
        content: "# Support Review\n\nCheck facts, gaps, and next questions."
      }
    ]);
    expect(config.agents[0]?.skillNames).toEqual(["support_review"]);
  });

  it("reads only skills allowed for the current agent", async () => {
    const tool = createReadSkillTool({
      catalog: new SkillCatalog({
        skills: [
          {
            name: "support_review",
            title: "Support Review",
            description: "Use when reviewing support case details.",
            content: "# Support Review\n\nCheck facts, gaps, and next questions."
          }
        ]
      }),
      getAgentSkillNames(agentName) {
        return agentName === "allowed_agent" ? ["support_review"] : [];
      }
    });
    const execution = new InProcessToolExecution({
      registry: new ToolRegistry({ tools: [tool] }),
      getAgentToolNames() {
        return ["read_skill"];
      }
    });
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
    const allowedRequest = {
      toolName: "read_skill",
      toolCallId: asToolCallId("toolcall_1"),
      agentRunId: asAgentRunId("run_1"),
      conversationId: asConversationId("conv_1"),
      agentName: "allowed_agent",
      input: { name: "support_review" }
    };

    const allowedDecision = await execution.authorize(allowedRequest, context);
    expect(allowedDecision.status).toBe("allowed");
    if (allowedDecision.status !== "allowed") {
      throw new Error("Expected allowed read_skill decision");
    }
    const allowedResult = await execution.execute(
      { ...allowedRequest, authorization: allowedDecision },
      context
    );
    expect(allowedResult).toMatchObject({
      status: "success",
      output: {
        name: "support_review",
        title: "Support Review",
        content: "# Support Review\n\nCheck facts, gaps, and next questions."
      }
    });
    if (allowedResult.status === "success") {
      expect((allowedResult.output as { sourceVersion: string }).sourceVersion).toMatch(/^sha256:/u);
    }

    const deniedRequest = {
      ...allowedRequest,
      toolCallId: asToolCallId("toolcall_2"),
      agentName: "other_agent"
    };
    const deniedDecision = await execution.authorize(deniedRequest, context);
    expect(deniedDecision.status).toBe("allowed");
    if (deniedDecision.status !== "allowed") {
      throw new Error("Expected allowed tool decision before skill-level denial");
    }
    const deniedResult = await execution.execute(
      { ...deniedRequest, authorization: deniedDecision },
      context
    );
    expect(deniedResult).toMatchObject({
      status: "failed",
      error: {
        code: "not_allowed"
      }
    });
  });
});
