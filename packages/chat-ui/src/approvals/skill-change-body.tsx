import type { ReactNode } from "react";
import { useTranslation } from "../i18n";
import { MarkdownArtifact } from "../markdown-text";
import { cn } from "../ui/cn";
import {
  SKILL_ROOT_TARGET,
  parseSkillChangePreview,
  type SkillChangePreviewChange,
  type SkillChangePreviewNewSkill
} from "./skill-change-preview";

/**
 * Plain-language view of a proposed skill change for people who never see the
 * skill source: whole paragraphs as "before" and "new", never a unified diff.
 * Renders nothing for a preview it cannot read; the card's summary remains.
 */
export function SkillChangeBody({ preview }: { preview: unknown }) {
  const { t } = useTranslation();
  const change = parseSkillChangePreview(preview);
  if (!change) {
    return null;
  }

  return (
    <div className="grid min-w-0 gap-3">
      <p className="text-xs text-muted-foreground">
        {change.isNewSkill
          ? t("skillChangeNewSkill")
          : t("skillChangeConcerns", { skill: change.skillTitle })}
      </p>
      {change.newSkill ? <NewSkill skill={change.newSkill} /> : null}
      {change.changes.map((entry, index) => (
        <SkillChange key={index} change={entry} />
      ))}
    </div>
  );
}

function SkillChange({ change }: { change: SkillChangePreviewChange }) {
  const { t } = useTranslation();
  const resource = change.target === SKILL_ROOT_TARGET ? undefined : change.target;

  if (change.type === "new_resource") {
    return (
      <ChangeBlock label={t("skillChangeNewResource")} detail={resource} tone="new">
        <CollapsedContent>{change.after}</CollapsedContent>
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
        <MarkdownArtifact>{change.after}</MarkdownArtifact>
      </ChangeBlock>
    );
  }

  return (
    <div className="grid min-w-0 gap-2">
      {change.before !== undefined ? (
        <ChangeBlock label={t("skillChangeBefore")} detail={location} tone="before">
          <MarkdownArtifact>{change.before}</MarkdownArtifact>
        </ChangeBlock>
      ) : null}
      <ChangeBlock
        label={t("skillChangeAfter")}
        detail={change.before === undefined ? location : undefined}
        tone="new"
      >
        <MarkdownArtifact>{change.after}</MarkdownArtifact>
      </ChangeBlock>
    </div>
  );
}

function NewSkill({ skill }: { skill: SkillChangePreviewNewSkill }) {
  return (
    <div className="grid min-w-0 gap-2 rounded-md border-l-2 border-primary bg-primary/5 px-3 py-2">
      <div className="grid min-w-0 gap-0.5">
        <strong className="font-medium text-foreground">{skill.title}</strong>
        {skill.description ? (
          <span className="text-muted-foreground">{skill.description}</span>
        ) : null}
      </div>
      <CollapsedContent>{skill.content}</CollapsedContent>
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

/** Long bodies stay one click away so a card in the thread keeps its shape. */
function CollapsedContent({ children }: { children: string }) {
  const { t } = useTranslation();
  return (
    <details className="min-w-0">
      <summary className="w-fit cursor-pointer rounded-sm text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
        {t("skillChangeShowContent")}
      </summary>
      <div className="mt-2 min-w-0">
        <MarkdownArtifact>{children}</MarkdownArtifact>
      </div>
    </details>
  );
}
