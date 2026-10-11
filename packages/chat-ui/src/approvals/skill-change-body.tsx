import type { ReactNode } from "react";
import { cn } from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import {
  SKILL_ROOT_TARGET,
  parseSkillChangePreview,
  type SkillChangePreviewChange,
  type SkillChangePreviewNewSkill
} from "./skill-change-preview";

/**
 * Plain-language view of a proposed skill change for people who never see the
 * skill source: whole paragraphs as "before" and "new", never a unified diff.
 * The text itself is shown as source, not rendered Markdown: the agent reads the
 * source, so comments, link definitions and raw HTML must stay visible to the reviewer.
 * Renders nothing for a preview it cannot read; the card's summary remains.
 */
export function SkillChangeBody({
  preview,
  heading = true,
  expanded = false
}: {
  preview: unknown;
  /** The line that names the skill. Left out where the surroundings already name it. */
  heading?: boolean;
  /** Shows a whole new text at once. In a thread it stays one click away. */
  expanded?: boolean;
}) {
  const { t } = useTranslation();
  const change = parseSkillChangePreview(preview);
  if (!change) {
    return null;
  }

  return (
    <div className="grid min-w-0 gap-3">
      {heading ? (
        <p className="text-xs text-muted-foreground">
          {change.isNewSkill
            ? t("skillChangeNewSkill")
            : t("skillChangeConcerns", { skill: change.skillTitle })}
        </p>
      ) : null}
      {change.newSkill ? <NewSkill skill={change.newSkill} expanded={expanded} /> : null}
      {change.changes.map((entry, index) => (
        <SkillChange key={index} change={entry} expanded={expanded} />
      ))}
    </div>
  );
}

function SkillChange({
  change,
  expanded
}: {
  change: SkillChangePreviewChange;
  expanded: boolean;
}) {
  const { t } = useTranslation();
  const resource = change.target === SKILL_ROOT_TARGET ? undefined : change.target;

  if (change.type === "new_resource") {
    return (
      <ChangeBlock label={t("skillChangeNewResource")} detail={resource} tone="new">
        <FullContent expanded={expanded}>{change.after}</FullContent>
      </ChangeBlock>
    );
  }

  const location = [
    change.sectionHeading
      ? t("skillChangeInSection", { heading: change.sectionHeading })
      : undefined,
    resource ? t("skillChangeInResource", { name: resource }) : undefined
  ]
    .filter(Boolean)
    .join(", ");

  if (change.type === "add") {
    return (
      <ChangeBlock label={t("skillChangeAdded")} detail={location} tone="new">
        <SourceText>{change.after}</SourceText>
      </ChangeBlock>
    );
  }

  return (
    <div className="grid min-w-0 gap-2">
      {change.before !== undefined ? (
        <ChangeBlock label={t("skillChangeBefore")} detail={location} tone="before">
          <SourceText>{change.before}</SourceText>
        </ChangeBlock>
      ) : null}
      <ChangeBlock
        label={t("skillChangeAfter")}
        detail={change.before === undefined ? location : undefined}
        tone="new"
      >
        <SourceText>{change.after}</SourceText>
      </ChangeBlock>
    </div>
  );
}

function NewSkill({ skill, expanded }: { skill: SkillChangePreviewNewSkill; expanded: boolean }) {
  return (
    <div className="grid min-w-0 gap-2 rounded-md border-l-2 border-primary bg-primary/5 px-3 py-2">
      <div className="grid min-w-0 gap-0.5">
        <strong className="font-medium text-foreground">{skill.title}</strong>
        {skill.description ? (
          <span className="text-muted-foreground">{skill.description}</span>
        ) : null}
      </div>
      <FullContent expanded={expanded}>{skill.content}</FullContent>
    </div>
  );
}

function ChangeBlock({
  label,
  detail,
  tone,
  children
}: {
  label: string;
  detail?: string;
  tone: "before" | "new";
  children: ReactNode;
}) {
  return (
    <div className="grid min-w-0 gap-1">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-xs">
        <span className="font-medium text-foreground">{label}</span>
        {detail ? <span className="min-w-0 text-muted-foreground">{detail}</span> : null}
      </div>
      <div
        className={cn(
          "min-w-0 rounded-md px-3 py-2",
          tone === "new"
            ? "border-l-2 border-primary bg-primary/5 text-foreground"
            : "bg-muted/60 text-muted-foreground"
        )}
      >
        {children}
      </div>
    </div>
  );
}

function SourceText({ children }: { children: string }) {
  return (
    <pre className="min-w-0 whitespace-pre-wrap font-mono text-[0.8125rem] leading-5 [overflow-wrap:anywhere]">
      {children}
    </pre>
  );
}

function FullContent({ expanded, children }: { expanded: boolean; children: string }) {
  return expanded ? (
    <SourceText>{children}</SourceText>
  ) : (
    <CollapsedContent>{children}</CollapsedContent>
  );
}

/** Long bodies stay one click away so a card in the thread keeps its shape. */
function CollapsedContent({ children }: { children: string }) {
  const { t } = useTranslation();
  return (
    <details className="min-w-0">
      <summary className="w-fit cursor-pointer rounded-sm text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
        {t("skillChangeShowContent")}
      </summary>
      <div className="mt-2 min-w-0">
        <SourceText>{children}</SourceText>
      </div>
    </details>
  );
}
