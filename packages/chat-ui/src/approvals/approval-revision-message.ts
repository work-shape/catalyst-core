import type { ApprovalRequestView } from "@vivd-catalyst/api-client";
import type { TranslationContextValue } from "../i18n";
import {
  SKILL_ROOT_TARGET,
  parseSkillChangePreview,
  type SkillChangePreview,
  type SkillChangePreviewChange
} from "./skill-change-preview";

/**
 * First user message of the conversation in which a reviewer revises someone
 * else's proposal. The agent there has never seen the proposal and the reviewer
 * has no access to the conversation it came from, so the message carries all of
 * it: the skill, the affected place, the proposed text and what to change.
 *
 * Built only from what the request's card already shows the reviewer.
 */
export function buildApprovalRevisionMessage(input: {
  request: Pick<ApprovalRequestView, "summary" | "preview">;
  comment: string;
  t: TranslationContextValue["t"];
}): string {
  const { request, t } = input;
  const preview = parseSkillChangePreview(request.preview);
  const summary = request.summary.trim();
  const blocks = [
    intro(preview, t),
    `${t("approvalRevisionMessageInstruction")}\n${input.comment.trim()}`,
    ...(summary ? [t("approvalRevisionMessageProposal", { summary })] : []),
    ...(preview ? proposedChangeBlocks(preview, t) : [])
  ];
  return blocks.join("\n\n");
}

function intro(preview: SkillChangePreview | undefined, t: TranslationContextValue["t"]): string {
  if (!preview) {
    return t("approvalRevisionMessageIntro");
  }
  return t(
    preview.isNewSkill
      ? "approvalRevisionMessageIntroNewSkill"
      : "approvalRevisionMessageIntroSkill",
    { skill: preview.skillTitle, skillName: preview.skillName }
  );
}

function proposedChangeBlocks(
  preview: SkillChangePreview,
  t: TranslationContextValue["t"]
): string[] {
  const blocks: string[] = [];
  if (preview.newSkill) {
    const { description, content } = preview.newSkill;
    blocks.push(
      [
        ...(description ? [t("approvalRevisionMessageDescription", { description })] : []),
        quoted(t("approvalRevisionMessageContent"), content)
      ].join("\n")
    );
  }
  for (const change of preview.changes) {
    blocks.push(changeBlock(change, t));
  }
  return blocks;
}

function changeBlock(change: SkillChangePreviewChange, t: TranslationContextValue["t"]): string {
  const place =
    change.target === SKILL_ROOT_TARGET
      ? t("approvalRevisionMessageTargetRoot")
      : t(
          change.type === "new_resource"
            ? "approvalRevisionMessageTargetNewResource"
            : "approvalRevisionMessageTargetResource",
          { name: change.target }
        );
  const section = change.sectionHeading
    ? t("approvalRevisionMessageSection", { heading: change.sectionHeading })
    : undefined;
  return [
    place,
    ...(section ? [section] : []),
    ...(change.before !== undefined ? [quoted(t("skillChangeBefore"), change.before)] : []),
    quoted(t(change.type === "add" ? "skillChangeAdded" : "skillChangeAfter"), change.after)
  ].join("\n");
}

/**
 * Skill text is Markdown and may hold code fences of its own. The fence around
 * it is one backtick longer than the longest run inside, so the quoted text
 * always ends where it really ends.
 */
function quoted(label: string, text: string): string {
  const longestRun = Math.max(0, ...(text.match(/`+/gu) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${label}:\n${fence}\n${text}\n${fence}`;
}
