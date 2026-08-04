import { describe, expect, it } from "vitest";
import { shouldExpandComposer } from "../packages/chat-ui/src/assistant/assistant-composer";

describe("assistant composer layout", () => {
  it("moves controls below the input for multiline drafts", () => {
    expect(shouldExpandComposer("First line")).toBe(false);
    expect(shouldExpandComposer("First line\nSecond line")).toBe(true);
    expect(shouldExpandComposer("A long line that wraps", true)).toBe(true);
  });

  it("returns to the compact row after the line break is removed", () => {
    expect(shouldExpandComposer("First line\n")).toBe(true);
    expect(shouldExpandComposer("First line")).toBe(false);
  });
});
