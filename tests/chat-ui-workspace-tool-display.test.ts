import { describe, expect, it } from "vitest";
import { summarizeWorkspaceCommand } from "../packages/chat-ui/src/workspace-tool-display";

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

    expect(summarizeWorkspaceCommand(command)).toBe("mkdir -p scripts");
  });

  it("skips strict-mode setup lines when summarizing multiline scripts", () => {
    expect(summarizeWorkspaceCommand("set -e\npython scripts/build.py\npptx_inspect deck.pptx --view summary")).toBe(
      "python"
    );
  });
});
