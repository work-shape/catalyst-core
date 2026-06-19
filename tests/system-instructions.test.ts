import { describe, expect, it } from "vitest";
import {
  CATALYST_INTERNAL_AGENT_PROMPT,
  createSystemInstructions
} from "../packages/agent-runtime/src/system-instructions";

describe("system instructions", () => {
  it("places Catalyst internal instructions before client agent instructions", () => {
    const content = createSystemInstructions("Use customer workflow rules.", "de", {
      currentDate: new Date("2026-06-19T12:00:00.000Z")
    });

    const catalystIndex = content.indexOf("Catalyst internal instructions:");
    const runtimeIndex = content.indexOf("Runtime context:");
    const clientIndex = content.indexOf("Client agent instructions:");

    expect(catalystIndex).toBe(0);
    expect(runtimeIndex).toBeGreaterThan(catalystIndex);
    expect(clientIndex).toBeGreaterThan(runtimeIndex);
    expect(content).toContain(CATALYST_INTERNAL_AGENT_PROMPT);
    expect(content).toContain("Keep the user informed with concise public text before tool calls");
    expect(content).toContain("- User selected language: German (locale: de).");
    expect(content).toContain("- Current date: Freitag, 19. Juni 2026 (ISO: 2026-06-19).");
    expect(content).not.toContain("Respond in German unless the user explicitly asks for another language.");
    expect(content).toContain("Use customer workflow rules.");
  });

  it("includes allowed skill metadata without full skill content", () => {
    const content = createSystemInstructions("Use customer workflow rules.", "en", {
      skills: [
        {
          name: "support_review",
          title: "Support Review",
          description: "Use when reviewing support case details."
        }
      ]
    });

    const skillsIndex = content.indexOf("Available client skills:");
    const clientIndex = content.indexOf("Client agent instructions:");

    expect(skillsIndex).toBeGreaterThan(0);
    expect(clientIndex).toBeGreaterThan(skillsIndex);
    expect(content).toContain(
      "- support_review: Support Review - Use when reviewing support case details."
    );
    expect(content).toContain("call read_skill");
    expect(content).not.toContain("# Support Review");
  });
});
