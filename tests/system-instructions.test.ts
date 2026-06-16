import { describe, expect, it } from "vitest";
import {
  CATALYST_INTERNAL_AGENT_PROMPT,
  createSystemInstructions
} from "../packages/agent-runtime/src/system-instructions";

describe("system instructions", () => {
  it("places Catalyst internal instructions before client agent instructions", () => {
    const content = createSystemInstructions("Use customer workflow rules.", "de");

    const catalystIndex = content.indexOf("Catalyst internal instructions:");
    const runtimeIndex = content.indexOf("Runtime instructions:");
    const clientIndex = content.indexOf("Client agent instructions:");

    expect(catalystIndex).toBe(0);
    expect(runtimeIndex).toBeGreaterThan(catalystIndex);
    expect(clientIndex).toBeGreaterThan(runtimeIndex);
    expect(content).toContain(CATALYST_INTERNAL_AGENT_PROMPT);
    expect(content).toContain("Before calling a tool, briefly say what you are going to inspect or do and why.");
    expect(content).toContain("Respond in German unless the user explicitly asks for another language.");
    expect(content).toContain("Use customer workflow rules.");
  });
});
