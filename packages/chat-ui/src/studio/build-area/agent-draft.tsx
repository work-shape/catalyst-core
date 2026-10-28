import type { ReactNode } from "react";
import type { AgentDraft } from "@work-shape/catalyst-api-client";
import { Badge, Banner, Button, FoldedText, ProposedValue } from "@work-shape/catalyst-ui";
import type { SharedDraftKind } from "../../shared/build-rights";
import { useTranslation } from "../../shared/i18n";
import { formatMomentShort } from "../../shared/locale-format";
import { reasoningEffortLabel } from "../../shared/reasoning-effort-label";
import {
  changedLanguages,
  draftAgentFields,
  draftAuthorLabel,
  draftSections,
  type DraftAgentField
} from "./agent-draft-model";
import type { AgentDraftAnswer } from "./agent-draft-source";
import type { AgentFormState, LocalizedPair } from "./asset-form-model";

/** The names people read for what an agent names by id, as far as the page knows them. */
export interface DraftTitles {
  skill(name: string): string;
  tool(name: string): string;
  knowledgeBase(id: string): string;
  model(bindingId: string): string;
}

/**
 * The draft badge of the page head: "Draft revision n". It is short so it fits beside the
 * head's actions; the banner under the head names the author and the time.
 */
export function AgentDraftBadge({ draft }: { draft: AgentDraft }) {
  const { t } = useTranslation();
  return (
    <Badge tone="warning" truncate data-agent-draft-badge={draft.revision}>
      {t("agentDraft.badge", { revision: draft.revision })}
    </Badge>
  );
}

/**
 * Where the page stands with the draft, said before its sections: what the draft is, why it
 * cannot be published, that somebody wrote a newer one, and what the last decision answered.
 */
export function AgentDraftNotice({
  draft,
  behind,
  name,
  publishRight,
  publishReasonId,
  answer,
  onLoad,
  kind = "agent"
}: {
  /** The draft the page shows. */
  draft: AgentDraft | null;
  /**
   * The draft the instance holds now, where it is another than the one the page shows while
   * the page holds changes of the reader's: a newer one, or none.
   */
  behind: { latest: AgentDraft | null } | undefined;
  /** The title of the agent as people know it now. */
  name: string;
  /** The right Publish needs, as people read it, where the reader does not hold it. */
  publishRight: string | undefined;
  /** The id of the sentence that names the right, which the disabled Publish points to. */
  publishReasonId: string;
  answer: AgentDraftAnswer | undefined;
  /** Reads the agent and its draft again: the page starts again from what holds. */
  onLoad(): void;
  /** Whose draft it is: an agent's, or a shared skill's (SKILL-DRAFT-1). */
  kind?: SharedDraftKind;
}) {
  const { locale, t } = useTranslation();
  const stale = draft !== null && (draft.stale || answer?.kind === "stale");
  const notices: ReactNode[] = [];
  if (behind !== undefined) {
    const { latest } = behind;
    notices.push(
      <Banner
        key="behind"
        tone="warning"
        data-agent-draft-behind={latest === null ? "gone" : latest.revision}
        action={
          <Button variant="outline" size="sm" onClick={onLoad}>
            {t(
              latest === null
                ? kind === "skill"
                  ? "agentDraft.loadSkill"
                  : "agentDraft.loadAgent"
                : "agentDraft.loadDraft"
            )}
          </Button>
        }
      >
        {latest === null
          ? t(kind === "skill" ? "agentDraft.goneSkill" : "agentDraft.gone")
          : // German closes the team's relative clause with a comma: a sentence of its own.
            t(latest.author.release ? "agentDraft.behindRelease" : "agentDraft.behind", {
              author: draftAuthorLabel(latest.author, t),
              revision: latest.revision,
              time: formatMomentShort(latest.updatedAt, locale)
            })}
      </Banner>
    );
  }
  if (draft !== null) {
    notices.push(
      stale ? (
        <Banner key="draft" tone="warning" data-agent-draft="stale">
          {t("agentDraft.stale", { name })}
        </Banner>
      ) : (
        <Banner key="draft" tone="info" data-agent-draft="pending">
          <div className="grid gap-1">
            {answer?.kind === "changed" ? <p>{t("agentDraft.changed")}</p> : null}
            {/* The head's badge gives way to the name where the row is full: the banner names
                the author and the time too. */}
            <p>
              {t(draft.author.release ? "agentDraft.pendingRelease" : "agentDraft.pending", {
                revision: draft.revision,
                name,
                author: draftAuthorLabel(draft.author, t),
                time: formatMomentShort(draft.updatedAt, locale)
              })}
            </p>
            {publishRight === undefined ? null : (
              <p id={publishReasonId}>
                {t("agentDraft.publishNeedsRight", { right: publishRight })}
              </p>
            )}
          </div>
        </Banner>
      )
    );
  }
  if (answer !== undefined && answer.kind !== "stale" && answer.kind !== "changed") {
    notices.push(
      <Banner
        key="answer"
        tone={answer.kind === "failed" ? "danger" : "warning"}
        data-agent-draft-answer={answer.kind}
      >
        {answer.kind === "failed" ? answer.message : t("configChangeWaitsForApproval")}
      </Banner>
    );
  }
  return notices.length === 0 ? null : <div className="mb-3 grid gap-2">{notices}</div>;
}

/**
 * What the draft changes on the page: its fields against the live agent, the sections that
 * hold them, and the published value to show under each.
 */
export function draftFieldsView(
  live: AgentFormState,
  draft: AgentFormState | undefined,
  titles: DraftTitles
): {
  fields: DraftAgentField[];
  sections: Set<string>;
  value(field: DraftAgentField): ReactNode;
  /** The field with its published value close under it, or the field alone. */
  around(field: DraftAgentField, input: ReactNode): ReactNode;
} {
  const fields = draft === undefined ? [] : draftAgentFields(live, draft);
  const value = (field: DraftAgentField) =>
    draft === undefined || !fields.includes(field) ? null : (
      <PublishedAgentValue field={field} live={live} draft={draft} titles={titles} />
    );
  return {
    fields,
    sections: draftSections(fields),
    value,
    // The published value belongs to its field: it sits closer to it than to the next field.
    around: (field, input) => {
      const shown = value(field);
      return shown === null ? (
        input
      ) : (
        <div className="grid gap-2" data-draft-group={field}>
          {input}
          {shown}
        </div>
      );
    }
  };
}

/** The mark after the heading of a section that holds a change of the draft. */
export function DraftSectionMark() {
  const { t } = useTranslation();
  return (
    <Badge tone="accent" appearance="outline" data-draft-section="">
      {t("agentDraft.sectionMark")}
    </Badge>
  );
}

/** The published value of one field, under the field that shows the draft. */
function PublishedAgentValue({
  field,
  live,
  draft,
  titles
}: {
  field: DraftAgentField;
  live: AgentFormState;
  draft: AgentFormState;
  titles: DraftTitles;
}) {
  const { t } = useTranslation();
  return (
    <ProposedValue label={t("agentDraft.label")} data-published-field={field}>
      <PublishedContent field={field} live={live} draft={draft} titles={titles} />
    </ProposedValue>
  );
}

function PublishedContent({
  field,
  live,
  draft,
  titles
}: {
  field: DraftAgentField;
  live: AgentFormState;
  draft: AgentFormState;
  titles: DraftTitles;
}): ReactNode {
  const { locale, t } = useTranslation();
  switch (field) {
    case "displayName":
    case "description":
    case "welcomeMessage":
    case "welcomeSubtitle":
      return <LanguageLines live={live[field]} draft={draft[field]} />;
    case "instructions":
      return <FoldedText>{live.instructions || t("agentDraft.empty")}</FoldedText>;
    case "additionalInstructions":
      return <FoldedText>{live.additionalInstructions || t("agentDraft.empty")}</FoldedText>;
    case "maxSteps":
      return live.maxSteps || t("configInstanceDefault");
    case "model":
      return <ModelLines live={live} draft={draft} titles={titles} />;
    case "skillNames":
      return <Names names={live.skillNames.map(titles.skill)} />;
    case "knowledgeBases":
      return <Names names={live.knowledgeBases.map(titles.knowledgeBase)} />;
    case "toolNames":
      return <Names names={live.toolNames.map(titles.tool)} />;
    case "initialPrompts":
      // A starter is told by its title in the reader's language.
      return (
        <Names
          names={live.initialPrompts.map(
            (prompt) => pairText(prompt.title, locale) || pairText(prompt.prompt, locale)
          )}
        />
      );
  }
}

/** A text of the reader's language, or of the other one where it is empty there. */
function pairText(pair: LocalizedPair, locale: string): string {
  return (locale === "de" ? pair.de || pair.en : pair.en || pair.de).trim();
}

/** The published names of a list, or that it holds none. */
function Names({ names }: { names: readonly string[] }) {
  const { t } = useTranslation();
  return <p>{names.length === 0 ? t("agentDraft.none") : names.join(", ")}</p>;
}

/** The languages whose text the draft changes, each with its published text. */
function LanguageLines({ live, draft }: { live: LocalizedPair; draft: LocalizedPair }) {
  const { t } = useTranslation();
  return (
    <dl className="grid gap-1">
      {changedLanguages(live, draft).map(({ language, text }) => (
        <div key={language} className="flex min-w-0 flex-wrap gap-x-2">
          <dt className="text-muted-foreground">
            {t(language === "en" ? "configEnglishLanguage" : "configGermanLanguage")}
          </dt>
          <dd className="min-w-0">{text || t("agentDraft.empty")}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The published model settings the draft changes, one line each. */
function ModelLines({
  live,
  draft,
  titles
}: {
  live: AgentFormState;
  draft: AgentFormState;
  titles: DraftTitles;
}) {
  const { t } = useTranslation();
  const lines: string[] = [];
  if (live.modelBindingId !== draft.modelBindingId) {
    lines.push(
      `${t("build.defaultModel")}: ${
        live.modelBindingId ? titles.model(live.modelBindingId) : t("configInstanceDefault")
      }`
    );
  }
  if (live.reasoningEffort !== draft.reasoningEffort) {
    lines.push(
      `${t("configReasoningEffort")}: ${
        live.reasoningEffort
          ? reasoningEffortLabel(live.reasoningEffort, t)
          : t("configModelDefault")
      }`
    );
  }
  if (live.fastMode !== draft.fastMode) {
    lines.push(`${t("configFastMode")}: ${t(live.fastMode ? "agentDraft.on" : "agentDraft.off")}`);
  }
  if (live.useModelFallback !== draft.useModelFallback) {
    lines.push(
      `${t("configModelFallback")}: ${t(live.useModelFallback ? "agentDraft.on" : "agentDraft.off")}`
    );
  }
  if (
    JSON.stringify(live.userSelectableModelBindingIds) !==
      JSON.stringify(draft.userSelectableModelBindingIds) ||
    lines.length === 0
  ) {
    // The efforts of the models people may choose, and the provider, have no line of their own.
    lines.push(
      `${t("build.selectableModels")}: ${
        live.userSelectableModelBindingIds.length === 0
          ? t("agentDraft.none")
          : live.userSelectableModelBindingIds.map(titles.model).join(", ")
      }`
    );
  }
  return (
    <div className="grid gap-1">
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}
