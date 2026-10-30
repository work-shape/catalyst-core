import { Fragment, useState, type HTMLAttributes } from "react";
import { cn } from "../cn";
import { useUiLabels } from "../ui-root";

/** One line of a diff: in both texts, only in the second, or only in the first. */
export interface DiffLine {
  kind: "same" | "added" | "removed";
  text: string;
  /** The line's number in the first text, where it stands there. */
  before?: number;
  /** The line's number in the second text, where it stands there. */
  after?: number;
}

/** Beyond this many differing lines the texts are shown as one removed and one added block. */
const MAX_EDITS = 4000;

function linesOf(text: string | undefined): string[] {
  if (text === undefined || text === "") return [];
  const lines = text.split("\n");
  // A last line break ends the last line; it starts no empty line of its own.
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * The lines of two texts, in order, each kept, added or removed: the shortest edit script by
 * Myers' algorithm. Texts too far apart are answered as every line removed, then every line
 * added. `undefined` is a text that does not exist, such as a file only one side holds.
 */
export function diffLines(before: string | undefined, after: string | undefined): DiffLine[] {
  const a = linesOf(before);
  const b = linesOf(after);
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= Math.min(max, MAX_EDITS); d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (v[k - 1 + offset] ?? 0) < (v[k + 1 + offset] ?? 0))
          ? (v[k + 1 + offset] ?? 0)
          : (v[k - 1 + offset] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, offset);
    }
  }
  return [
    ...a.map((text, index): DiffLine => ({ kind: "removed", text, before: index + 1 })),
    ...b.map((text, index): DiffLine => ({ kind: "added", text, after: index + 1 }))
  ];
}

function backtrack(
  trace: readonly Int32Array[],
  a: readonly string[],
  b: readonly string[],
  offset: number
): DiffLine[] {
  const out: DiffLine[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const v = trace[d];
    if (v === undefined) break;
    const k = x - y;
    const previousK =
      k === -d || (k !== d && (v[k - 1 + offset] ?? 0) < (v[k + 1 + offset] ?? 0)) ? k + 1 : k - 1;
    const previousX = v[previousK + offset] ?? 0;
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      out.push({ kind: "same", text: a[x - 1] ?? "", before: x, after: y });
      x -= 1;
      y -= 1;
    }
    if (d > 0) {
      if (x === previousX) out.push({ kind: "added", text: b[y - 1] ?? "", after: y });
      else out.push({ kind: "removed", text: a[x - 1] ?? "", before: x });
    }
    x = previousX;
    y = previousY;
  }
  return out.reverse();
}

/**
 * In how many places two texts differ: each run of added and removed lines between kept lines
 * counts once. `0` where they hold the same lines.
 */
export function changedPlaces(before: string | undefined, after: string | undefined): number {
  let places = 0;
  let inChange = false;
  for (const line of diffLines(before, after)) {
    const changed = line.kind !== "same";
    if (changed && !inChange) places += 1;
    inChange = changed;
  }
  return places;
}

/** A run of lines as the diff shows it: lines, or kept lines folded under one row. */
type Part = { kind: "lines"; lines: DiffLine[] } | { kind: "fold"; id: number; lines: DiffLine[] };

/** Keeps `context` kept lines beside each change and folds every longer run of kept lines. */
function partsOf(lines: readonly DiffLine[], context: number): Part[] {
  const parts: Part[] = [];
  let shown: DiffLine[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    if (line.kind !== "same") {
      shown.push(line);
      index += 1;
      continue;
    }
    let end = index;
    while (lines[end]?.kind === "same") end += 1;
    const run = lines.slice(index, end);
    const head = index === 0 ? 0 : context;
    const tail = end === lines.length ? 0 : context;
    if (run.length > head + tail + 1) {
      shown.push(...run.slice(0, head));
      if (shown.length > 0) parts.push({ kind: "lines", lines: shown });
      parts.push({ kind: "fold", id: index, lines: run.slice(head, run.length - tail) });
      shown = run.slice(run.length - tail);
    } else {
      shown.push(...run);
    }
    index = end;
  }
  if (shown.length > 0) parts.push({ kind: "lines", lines: shown });
  return parts;
}

export interface TextDiffProps extends HTMLAttributes<HTMLDivElement> {
  /** The text as it is live. Absent: the text is new. */
  before?: string | undefined;
  /** The text of the draft. Absent: the text is removed. */
  after?: string | undefined;
  /** How many kept lines stand beside each change before the rest folds. */
  context?: number;
}

const lineTones: Record<DiffLine["kind"], string> = {
  same: "",
  added: "bg-success-soft text-success-soft-foreground",
  removed: "bg-destructive-soft text-destructive-soft-foreground"
};

const signs: Record<DiffLine["kind"], string> = { same: " ", added: "+", removed: "−" };

/**
 * Two versions of one text, line by line: an added line on the success tint with "+", a
 * removed one on the destructive tint with "−", and every longer run of lines both hold folded
 * to one row that opens it. The sign and the tint are said in words to a screen reader. Long
 * lines wrap, so the diff fits a phone's width.
 */
export function TextDiff({ before, after, context = 3, className, ...props }: TextDiffProps) {
  const labels = useUiLabels("TextDiff");
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set());
  const lines = diffLines(before, after);
  if (lines.every((line) => line.kind === "same")) {
    return (
      <div
        data-text-diff="same"
        className={cn("px-3 py-2 text-body text-muted-foreground", className)}
        {...props}
      >
        {labels.diffSame}
      </div>
    );
  }
  const row = (line: DiffLine, key: string) => (
    <div
      key={key}
      data-diff-line={line.kind}
      className={cn("grid grid-cols-[3rem_1.25rem_minmax(0,1fr)]", lineTones[line.kind])}
    >
      <span
        aria-hidden="true"
        className="pr-2 text-right text-muted-foreground tabular-nums select-none"
      >
        {line.after ?? line.before}
      </span>
      <span aria-hidden="true" className="select-none">
        {signs[line.kind]}
      </span>
      <span className="whitespace-pre-wrap wrap-anywhere">
        {line.kind === "same" ? null : (
          <span className="sr-only">
            {line.kind === "added" ? labels.diffAdded : labels.diffRemoved}:{" "}
          </span>
        )}
        {line.text === "" ? "​" : line.text}
      </span>
    </div>
  );
  return (
    <div
      data-text-diff="changed"
      className={cn("overflow-hidden py-1 font-mono text-code", className)}
      {...props}
    >
      {partsOf(lines, context).map((part, index) =>
        part.kind === "lines" ? (
          <Fragment key={`lines-${index}`}>
            {part.lines.map((line, at) => row(line, `${index}-${at}`))}
          </Fragment>
        ) : opened.has(part.id) ? (
          <Fragment key={`fold-${part.id}`}>
            {part.lines.map((line, at) => row(line, `${part.id}-${at}`))}
          </Fragment>
        ) : (
          <button
            key={`fold-${part.id}`}
            type="button"
            data-diff-fold={part.lines.length}
            className="my-0.5 block w-full bg-muted px-3 py-0.5 text-left font-sans text-caption text-muted-foreground hover:bg-state-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            onClick={() => setOpened((now) => new Set([...now, part.id]))}
          >
            {part.lines.length === 1
              ? labels.diffUnchangedOne
              : labels.diffUnchangedMany.replace("{count}", String(part.lines.length))}
          </button>
        )
      )}
    </div>
  );
}
