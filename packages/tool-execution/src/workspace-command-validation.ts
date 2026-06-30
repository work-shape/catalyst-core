import { posix as path } from "node:path";
import { validationFailed, type ValidationResult } from "./workspace-tool-results";

const helperFlagSubstituteCommands = new Set(["cat", "ls"]);
const helperOnlyFlags = ["--view", "--out", "--range"] as const;

export function validateWorkspaceShellCommand(command: string): ValidationResult<void> {
  const significantLines = command
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const firstLine = significantLines[0];
  if (firstLine && /^set(?:\s|$)/u.test(firstLine)) {
    const shellSetup = validateShellSetupLine(firstLine, significantLines.length);
    if (shellSetup.status === "failed") {
      return shellSetup;
    }
  }
  for (const line of significantLines) {
    const fileCommand = validateFileDisplayCommandLine(line);
    if (fileCommand.status === "failed") {
      return fileCommand;
    }
  }
  return { status: "success", value: undefined };
}

function validateShellSetupLine(firstLine: string, significantLineCount: number): ValidationResult<void> {
  if (/[;&|]/u.test(firstLine)) {
    return { status: "success", value: undefined };
  }
  const tokens = splitShellWords(firstLine);
  if (!tokens || tokens[0] !== "set") {
    return { status: "success", value: undefined };
  }
  const setArguments = tokens.slice(1);
  const hasCommandLikeSetArgument = setArguments.some((argument) => !argument.startsWith("-") && !argument.startsWith("+"));
  if (tokens.length === 1 || significantLineCount === 1 || hasCommandLikeSetArgument) {
    return validationFailed(
      "workspace.exec received shell setup without a command. Run helpers directly, or put set -e on its own line before the command.",
      {
        example: "pptx_render deck.pptx --out previews/slides",
        multilineExample: "set -e\npptx_render deck.pptx --out previews/slides"
      }
    );
  }
  return { status: "success", value: undefined };
}

function validateFileDisplayCommandLine(line: string): ValidationResult<void> {
  const tokens = splitShellWords(line);
  if (!tokens || tokens.length === 0) {
    return { status: "success", value: undefined };
  }
  const commandName = path.basename(tokens[0] ?? "");
  if (!helperFlagSubstituteCommands.has(commandName)) {
    return { status: "success", value: undefined };
  }
  const args = tokens.slice(1);
  const helperFlag = args.find((argument) =>
    helperOnlyFlags.some((flag) => argument === flag || argument.startsWith(`${flag}=`))
  );
  const catWithLsFlags = commandName === "cat" && args.some((argument) => argument === "-lh" || argument === "-hl");
  if (!helperFlag && !catWithLsFlags) {
    return { status: "success", value: undefined };
  }
  return validationFailed(
    "workspace.exec received cat/ls with artifact helper flags. Run the artifact helper directly, or use ls -lh only for file size checks.",
    {
      command: commandName,
      helperFlags: [...helperOnlyFlags],
      example: "pptx_inspect deck.pptx --view summary",
      renderExample: "pptx_render deck.pptx --out previews/slides",
      fileSizeExample: "ls -lh deck.pptx"
    }
  );
}

function splitShellWords(line: string): string[] | undefined {
  const words: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  for (const character of line) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      if (current.length > 0) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (quote || escaped) {
    return undefined;
  }
  if (current.length > 0) {
    words.push(current);
  }
  return words;
}
