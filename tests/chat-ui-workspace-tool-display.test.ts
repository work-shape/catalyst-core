import { describe, expect, it } from "vitest";
import {
  formatWorkspaceCommandActionLabel,
  projectWorkspaceToolDisplay
} from "../packages/chat-ui/src/workspace-tool-display";

describe("workspace tool display", () => {
  it("shows the actual sanitized multiline workspace command label", () => {
    const command = [
      "mkdir -p scripts artifacts previews/surprise_deck",
      "cat > scripts/build_surprise_deck.py <<'PY'",
      "body.fill.solid()",
      "PY",
      "python scripts/build_surprise_deck.py",
      "pptx_inspect artifacts/deck.pptx --view summary",
      "pptx_render artifacts/deck.pptx --out previews/surprise_deck"
    ].join("\n");
    const inlineCommand = command.split("\n").map((line) => line.trim()).join(" ");

    expect(formatWorkspaceCommandActionLabel(command)).toBe(inlineCommand);
    const projection = projectWorkspaceToolDisplay({
      args: { command },
      result: { output: { status: "failed", exitCode: 2 } },
      toolName: "workspace.exec"
    });

    expect(projection?.actionLabel).toBe(inlineCommand);
    expect(projection?.sections.find((section) => section.label === "Command")?.value).toContain(
      "cat > scripts/build_surprise_deck.py <<'PY'\nbody.fill.solid()"
    );
    expect(projection?.sections.find((section) => section.label === "Command")?.value).toContain(
      "pptx_inspect artifacts/deck.pptx --view summary"
    );
  });

  it("keeps strict-mode setup lines in the actual command label", () => {
    expect(
      formatWorkspaceCommandActionLabel("set -e\npython scripts/build.py\npptx_inspect deck.pptx --view summary")
    ).toBe("set -e python scripts/build.py pptx_inspect deck.pptx --view summary");
  });
});
