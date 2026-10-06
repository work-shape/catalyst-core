import type { ApprovalRequestView } from "@vivd-catalyst/api-client";
import type { TranslationContextValue } from "../i18n";
import {
  SKILL_ROOT_TARGET,
  parseSkillChangePreview,
  type SkillChangePreview,
  type SkillChangePreviewChange
} from "./skill-change-preview";

type Translate = TranslationContextValue["t"];

/** Changed lines the message shows before it only counts the rest. */
export const REVISION_MESSAGE_MAX_CHANGED_LINES = 40;

const REMOVED_PREFIX = "− ";
/** Escaped: a line starting with a bare plus sign is a Markdown list item. */
const ADDED_PREFIX = "\\+ ";
/** Markdown hard break, so every changed line keeps a line of its own. */
const HARD_BREAK = "  \n";

/**
 * First user message of the conversation in which a reviewer revises someone
 * else's proposal. The agent there has never seen the proposal and the reviewer
 * has no access to the conversation it came from. The message stays short: what
 * to revise, the instruction, where the change sits and only the lines the
 * proposal changed. The agent reads the skill itself for everything else.
 *
 * Built only from what the request's card already shows the reviewer.
 */
export function buildApprovalRevisionMessage(input: {
  request: Pick<ApprovalRequestView, "summary" | "preview">;
  comment: string;
  t: Translate;
}): string {
  const { request, t } = input;
  const preview = parseSkillChangePreview(request.preview);
  const summary = request.summary.trim();
  const budget = { remaining: REVISION_MESSAGE_MAX_CHANGED_LINES, omitted: 0 };
  const blocks = [
    intro(preview, t),
    t("approvalRevisionMessageInstruction", { comment: input.comment.trim() }),
    ...(summary ? [t("approvalRevisionMessageProposal", { summary })] : []),
    ...(preview ? proposedChangeBlocks(preview, budget, t) : []),
    ...(budget.omitted > 0
      ? [t("approvalRevisionMessageMoreLines", { count: budget.omitted })]
      : [])
  ];
  return blocks.join("\n\n");
}

function intro(preview: SkillChangePreview | undefined, t: Translate): string {
  if (!preview) {
    return t("approvalRevisionMessageIntro");
  }
  const skill = { skill: preview.skillTitle, skillName: preview.skillName };
  // A proposed new skill does not exist yet, so there is nothing to read.
  return preview.isNewSkill
    ? t("approvalRevisionMessageIntroNewSkill", skill)
    : `${t("approvalRevisionMessageIntroSkill", skill)} ${t("approvalRevisionMessageReadFirst")}`;
}

interface LineBudget {
  remaining: number;
  omitted: number;
}

function proposedChangeBlocks(
  preview: SkillChangePreview,
  budget: LineBudget,
  t: Translate
): string[] {
  const blocks: string[] = [];
  if (preview.newSkill) {
    const { description, content } = preview.newSkill;
    blocks.push(
      block(
        description ? t("approvalRevisionMessageDescription", { description }) : undefined,
        changedLines(undefined, content),
        budget
      )
    );
  }
  for (const change of preview.changes) {
    blocks.push(block(place(change, t), changedLines(change.before, change.after), budget));
  }
  return blocks.filter(Boolean);
}

function place(change: SkillChangePreviewChange, t: Translate): string {
  const file =
    change.target === SKILL_ROOT_TARGET
      ? t("approvalRevisionMessageTargetRoot")
      : t(
          change.type === "new_resource"
            ? "approvalRevisionMessageTargetNewResource"
            : "approvalRevisionMessageTargetResource",
          { name: change.target }
        );
  return change.sectionHeading
    ? `${file}, ${t("skillChangeInSection", { heading: change.sectionHeading })}`
    : file;
}

/** One place and the lines changed there, as a blockquote rather than a code block. */
function block(heading: string | undefined, lines: string[], budget: LineBudget): string {
  const shown = lines.slice(0, budget.remaining);
  budget.remaining -= shown.length;
  budget.omitted += lines.length - shown.length;
  const quote = shown.map((line) => `> ${line}`).join(HARD_BREAK);
  return [heading, quote].filter(Boolean).join("\n\n");
}

/**
 * The lines a change removes and adds, in reading order. Unchanged and blank
 * lines are left out. Text without a "before" is new as a whole.
 */
export function changedLines(before: string | undefined, after: string): string[] {
  const removedFrom = splitLines(before ?? "");
  const addedTo = splitLines(after);
  const kept = commonLines(removedFrom, addedTo);
  const changed: string[] = [];
  let removedIndex = 0;
  let addedIndex = 0;
  for (const [keptRemoved, keptAdded] of [...kept, [removedFrom.length, addedTo.length] as const]) {
    for (; removedIndex < keptRemoved; removedIndex += 1) {
      pushChanged(changed, REMOVED_PREFIX, removedFrom[removedIndex]);
    }
    for (; addedIndex < keptAdded; addedIndex += 1) {
      pushChanged(changed, ADDED_PREFIX, addedTo[addedIndex]);
    }
    removedIndex = keptRemoved + 1;
    addedIndex = keptAdded + 1;
  }
  return changed;
}

function pushChanged(changed: string[], prefix: string, line: string | undefined): void {
  const text = line?.trim();
  if (text) {
    changed.push(`${prefix}${text}`);
  }
}

/** Blank lines carry nothing to revise and would only pair up unrelated places. */
function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

/** Index pairs of a longest common subsequence of lines. */
function commonLines(left: string[], right: string[]): Array<readonly [number, number]> {
  const width = right.length + 1;
  const lengths = new Uint32Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      lengths[i * width + j] =
        left[i] === right[j]
          ? (lengths[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lengths[(i + 1) * width + j] ?? 0, lengths[i * width + j + 1] ?? 0);
    }
  }
  const pairs: Array<readonly [number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if ((lengths[(i + 1) * width + j] ?? 0) >= (lengths[i * width + j + 1] ?? 0)) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}
