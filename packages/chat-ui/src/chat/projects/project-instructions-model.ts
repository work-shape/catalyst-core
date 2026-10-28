import {
  isProjectInstructionsPath,
  PROJECT_INSTRUCTIONS_MAX_CHARS,
  PROJECT_INSTRUCTIONS_PATH
} from "@work-shape/catalyst-core";

export { PROJECT_INSTRUCTIONS_MAX_CHARS, PROJECT_INSTRUCTIONS_PATH };

// The instructions of a project (PRJ-3), its `AGENTS.md`: what a change of the agent would make
// of them, and how a change reads for a person. A person reads whole paragraphs as "Before" and
// "New", never a unified diff, as a skill change reads.

/** The file tools whose call can change the project's instructions. */
const WRITE_TOOL = "workspace.write_file";
const EDIT_TOOL = "workspace.edit_file";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A call of the agent that writes or edits `project/AGENTS.md`. */
export function isProjectInstructionsCall(call: {
  operationId: string;
  inputPreview: unknown;
}): boolean {
  if (call.operationId !== WRITE_TOOL && call.operationId !== EDIT_TOOL) return false;
  const input = call.inputPreview;
  return isRecord(input) && typeof input.path === "string" && isProjectInstructionsPath(input.path);
}

/**
 * The text the instructions would have after the call: a write's content, or the current text
 * with an edit's passages replaced. Nothing where an edit's passage is not in the text once, as
 * the tool itself would refuse it then.
 */
export function proposedInstructions(
  call: { operationId: string; inputPreview: unknown },
  current: string
): string | undefined {
  const input = call.inputPreview;
  if (!isRecord(input)) return undefined;
  if (call.operationId === WRITE_TOOL) {
    return typeof input.content === "string" ? input.content : undefined;
  }
  if (!Array.isArray(input.edits)) return undefined;
  let text = current;
  for (const edit of input.edits) {
    if (!isRecord(edit) || typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
      return undefined;
    }
    const at = text.indexOf(edit.oldText);
    if (edit.oldText === "" || at === -1 || text.indexOf(edit.oldText, at + 1) !== -1) {
      return undefined;
    }
    text = text.slice(0, at) + edit.newText + text.slice(at + edit.oldText.length);
  }
  return text;
}

/** What changes between two texts, in whole paragraphs. */
export interface InstructionsChange {
  /** The paragraphs that go; empty where only text is added. */
  before: string;
  /** The paragraphs that come instead; empty where only text is removed. */
  after: string;
}

function paragraphs(text: string): string[] {
  return text
    .replace(/\r\n/gu, "\n")
    .split(/\n[ \t]*\n/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");
}

/**
 * The paragraphs that differ between two texts: everything between the paragraphs both share
 * at their start and at their end. Nothing where the paragraphs are the same.
 */
export function instructionsChange(before: string, after: string): InstructionsChange | undefined {
  const old = paragraphs(before);
  const next = paragraphs(after);
  let start = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start += 1;
  let end = 0;
  while (
    end < old.length - start &&
    end < next.length - start &&
    old[old.length - 1 - end] === next[next.length - 1 - end]
  ) {
    end += 1;
  }
  const removed = old.slice(start, old.length - end);
  const added = next.slice(start, next.length - end);
  if (removed.length === 0 && added.length === 0) return undefined;
  return { before: removed.join("\n\n"), after: added.join("\n\n") };
}

/** Whether a run takes only the start of these instructions. */
export function instructionsTruncated(text: string): boolean {
  return Array.from(text).length > PROJECT_INSTRUCTIONS_MAX_CHARS;
}
