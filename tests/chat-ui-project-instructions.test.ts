import { describe, expect, it } from "vitest";
import {
  instructionsChange,
  instructionsTruncated,
  isProjectInstructionsCall,
  proposedInstructions
} from "./support/chat-ui";

// PRJ-3: the card on which a person allows the agent's change of a project's AGENTS.md shows
// what the instructions would become, in whole paragraphs as "Before" and "New".

const write = (path: string, content: string) => ({
  operationId: "workspace.write_file",
  inputPreview: { path, content }
});
const edit = (edits: Array<{ oldText: string; newText: string }>) => ({
  operationId: "workspace.edit_file",
  inputPreview: { path: "project/AGENTS.md", edits }
});

describe("a change of a project's instructions", () => {
  it("is a write or edit of project/AGENTS.md, and of no other file", () => {
    expect(isProjectInstructionsCall(write("project/AGENTS.md", "x"))).toBe(true);
    expect(isProjectInstructionsCall(edit([]))).toBe(true);
    expect(isProjectInstructionsCall(write("project/notizen/AGENTS.md", "x"))).toBe(false);
    expect(isProjectInstructionsCall(write("AGENTS.md", "x"))).toBe(false);
    expect(
      isProjectInstructionsCall({
        operationId: "workspace.read_file",
        inputPreview: { path: "project/AGENTS.md" }
      })
    ).toBe(false);
  });

  it("would make the instructions a write's content, or the text with an edit's passages replaced", () => {
    expect(proposedInstructions(write("project/AGENTS.md", "Neu."), "Alt.")).toBe("Neu.");
    expect(
      proposedInstructions(
        edit([{ oldText: "knapp", newText: "ausführlich" }]),
        "Antworte knapp.\n\nNenne die Quelle."
      )
    ).toBe("Antworte ausführlich.\n\nNenne die Quelle.");
    // As the tool, it applies no passage that is missing or there twice.
    expect(proposedInstructions(edit([{ oldText: "fehlt", newText: "x" }]), "Text")).toBe(
      undefined
    );
    expect(proposedInstructions(edit([{ oldText: "a", newText: "b" }]), "a a")).toBe(undefined);
  });

  it("reads as the paragraphs that go and the ones that come", () => {
    const before = "Antworte auf Deutsch.\n\nAntworte knapp.\n\nNenne die Quelle.";
    expect(
      instructionsChange(
        before,
        "Antworte auf Deutsch.\n\nAntworte ausführlich.\n\nNenne die Quelle."
      )
    ).toEqual({ before: "Antworte knapp.", after: "Antworte ausführlich." });
    expect(instructionsChange(before, `${before}\n\nDuze die Kunden.`)).toEqual({
      before: "",
      after: "Duze die Kunden."
    });
    expect(instructionsChange(before, "Antworte auf Deutsch.\n\nNenne die Quelle.")).toEqual({
      before: "Antworte knapp.",
      after: ""
    });
    expect(instructionsChange(before, `${before}\n`)).toBe(undefined);
  });

  it("says where a chat takes only the start of the text", () => {
    expect(instructionsTruncated("x".repeat(16_000))).toBe(false);
    expect(instructionsTruncated("x".repeat(16_001))).toBe(true);
  });
});
