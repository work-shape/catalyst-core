import { describe, expect, it } from "vitest";
import { agentChangeLines, withRunUnderway } from "./support/chat-ui";

// T30, wish 2: where another agent answers from a message on, the history says so above that
// message, read from the runs' agents so every reader sees it, after a reload too.

const message = (id: string) => ({ id });
const run = (inputMessageId: string, agentName: string) => ({ inputMessageId, agentName });

describe("agent change lines", () => {
  it("gives the first run no line", () => {
    expect([...agentChangeLines([message("m1"), message("a1")], [run("m1", "general")])]).toEqual(
      []
    );
  });

  it("marks the message from which another agent answers, and the change back", () => {
    const messages = ["m1", "a1", "m2", "a2", "m3", "a3", "m4", "a4"].map(message);
    const lines = agentChangeLines(messages, [
      run("m1", "general"),
      run("m2", "general"),
      run("m3", "personal"),
      run("m4", "general")
    ]);
    expect([...lines]).toEqual([
      ["m3", "personal"],
      ["m4", "general"]
    ]);
  });

  it("skips messages that started no run and counts a message's last run", () => {
    const messages = ["m1", "a1", "s1", "m2", "a2"].map(message);
    // `s1` was steered into the first run; `m2` was answered again by another agent.
    const lines = agentChangeLines(messages, [
      run("m1", "general"),
      run("m2", "general"),
      run("m2", "personal")
    ]);
    expect([...lines]).toEqual([["m2", "personal"]]);
  });

  it("adds the run underway until the thread names it", () => {
    const listed = [run("m1", "general")];
    expect(withRunUnderway(listed, undefined, undefined)).toBe(listed);
    expect(withRunUnderway(listed, "m1", "general")).toBe(listed);
    expect(withRunUnderway(listed, "m2", "personal")).toEqual([
      run("m1", "general"),
      run("m2", "personal")
    ]);
  });
});
