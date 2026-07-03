import { describe, expect, it } from "vitest";
import {
  projectWorkspaceToolDisplay,
  summarizeWorkspaceCommand
} from "../packages/chat-ui/src/workspace-tool-display";

describe("workspace tool display", () => {
  it("summarizes multiline workspace scripts without heredoc body or later helper flags", () => {
    const command = [
      "mkdir -p scripts artifacts previews/surprise_deck",
      "cat > scripts/build_surprise_deck.py <<'PY'",
      "body.fill.solid()",
      "PY",
      "python scripts/build_surprise_deck.py",
      "pptx_inspect artifacts/deck.pptx --view summary",
      "pptx_render artifacts/deck.pptx --out previews/surprise_deck"
    ].join("\n");

    expect(summarizeWorkspaceCommand(command)).toBe("workspace script");
    const projection = projectWorkspaceToolDisplay({
      args: { command },
      result: { output: { status: "failed", exitCode: 2 } },
      toolName: "workspace.exec"
    });

    expect(projection?.actionLabel).toBe("workspace script");
    expect(projection?.sections.find((section) => section.label === "Command")?.value).toContain(
      "cat > scripts/build_surprise_deck.py <<'PY'\nbody.fill.solid()"
    );
    expect(projection?.sections.find((section) => section.label === "Command")?.value).toContain(
      "pptx_inspect artifacts/deck.pptx --view summary"
    );
  });

  it("skips strict-mode setup lines when summarizing multiline scripts", () => {
    expect(summarizeWorkspaceCommand("set -e\npython scripts/build.py\npptx_inspect deck.pptx --view summary")).toBe(
      "workspace script"
    );
  });
});
