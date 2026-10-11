/** One replacement of `workspace.edit_file`: text the file has, and the text that replaces it. */
export interface WorkspaceTextEdit {
  oldText: string;
  newText: string;
}

/** Why a set of edits was refused. `edit` and `other` are positions in the `edits` input. */
export type WorkspaceTextEditFailure =
  | { kind: "empty_old_text"; edit: number }
  | { kind: "no_change"; edit: number }
  /** `nearLine` is where the text stands with other whitespace or line endings. */
  | { kind: "not_found"; edit: number; nearLine?: number }
  | { kind: "not_unique"; edit: number; occurrences: number; lines: number[] }
  | { kind: "overlap"; edit: number; other: number };

export type WorkspaceTextEditResult =
  { status: "success"; text: string } | { status: "failed"; failure: WorkspaceTextEditFailure };

/** How many line numbers a refusal names for a text that occurs several times. */
const LISTED_OCCURRENCE_LINES = 5;

/**
 * Replaces exact text. Every `oldText` is searched in the text as it is, not in the result of
 * the edits before it, and has to occur exactly once. Two edits may not change the same
 * characters. Either every edit applies or the text is answered unchanged as a failure.
 * Nothing is normalized: line endings and whitespace count.
 */
export function applyWorkspaceTextEdits(
  text: string,
  edits: readonly WorkspaceTextEdit[]
): WorkspaceTextEditResult {
  const matches: { edit: number; start: number; end: number; newText: string }[] = [];
  for (const [edit, { oldText, newText }] of edits.entries()) {
    if (oldText.length === 0) {
      return failure({ kind: "empty_old_text", edit });
    }
    if (oldText === newText) {
      return failure({ kind: "no_change", edit });
    }
    const found = occurrencesOf(text, oldText);
    const [start] = found.first;
    if (start === undefined) {
      const nearLine = lineOfLooseMatch(text, oldText);
      return failure({ kind: "not_found", edit, ...(nearLine === undefined ? {} : { nearLine }) });
    }
    if (found.count > 1) {
      return failure({
        kind: "not_unique",
        edit,
        occurrences: found.count,
        lines: found.first.map((index) => lineAt(text, index))
      });
    }
    matches.push({ edit, start, end: start + oldText.length, newText });
  }

  const ordered = [...matches].sort((left, right) => left.start - right.start);
  let result = "";
  let cursor = 0;
  let previous: (typeof ordered)[number] | undefined;
  for (const match of ordered) {
    if (previous && match.start < previous.end) {
      return failure({
        kind: "overlap",
        edit: Math.min(previous.edit, match.edit),
        other: Math.max(previous.edit, match.edit)
      });
    }
    result += text.slice(cursor, match.start) + match.newText;
    cursor = match.end;
    previous = match;
  }
  return { status: "success", text: result + text.slice(cursor) };
}

function failure(value: WorkspaceTextEditFailure): WorkspaceTextEditResult {
  return { status: "failed", failure: value };
}

/**
 * How often the text stands there, also where two occurrences share characters, and the first
 * positions of it.
 */
function occurrencesOf(text: string, search: string): { count: number; first: number[] } {
  const first: number[] = [];
  let count = 0;
  for (let index = text.indexOf(search); index !== -1; index = text.indexOf(search, index + 1)) {
    count += 1;
    if (first.length < LISTED_OCCURRENCE_LINES) {
      first.push(index);
    }
  }
  return { count, first };
}

/** The line, counted from 1, that holds the character at `index`. */
function lineAt(text: string, index: number): number {
  let line = 1;
  for (let at = text.indexOf("\n"); at !== -1 && at < index; at = text.indexOf("\n", at + 1)) {
    line += 1;
  }
  return line;
}

/**
 * The line where the text stands once line endings and blanks at line ends are left out of
 * both sides. It only helps to say why an exact search found nothing; nothing is edited by it.
 */
function lineOfLooseMatch(text: string, search: string): number | undefined {
  const looseSearch = withoutLineEndNoise(search);
  if (looseSearch.length === 0) {
    return undefined;
  }
  const looseText = withoutLineEndNoise(text);
  const index = looseText.indexOf(looseSearch);
  // Leaving the noise out removes no line break, so the line is the same in the file.
  return index === -1 ? undefined : lineAt(looseText, index);
}

function withoutLineEndNoise(value: string): string {
  return value
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
}
