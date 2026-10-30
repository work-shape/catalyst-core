import type { ReactNode } from "react";
import type { AgentDraft } from "@work-shape/catalyst-api-client";
import { Banner, Button, ProposedValue } from "@work-shape/catalyst-ui";
import { AssetStatus } from "../asset-head";
import type { SharedDraftKind } from "../../shared/build-rights";
import { useTranslation } from "../../shared/i18n";
import { formatMomentShort } from "../../shared/locale-format";
import { reasoningEffortLabel } from "../../shared/reasoning-effort-label";
import { draftAgentFields, draftAuthorLabel, type DraftAgentField } from "./agent-draft-model";
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
 * The one state after the agent's name: "Draft · not live" while it has a draft, whose popover
 * names its revision, who saved it when and the live version, or a quiet "Live".
 */
export function AgentDraftStatus({
  draft,
  publishRight,
  onShowChanges
}: {
  /** The draft the page shows, or none. */
  draft: AgentDraft | null;
  /** The right Publish needs, as people read it, where the reader does not hold it. */
  publishRight?: string | undefined;
  onShowChanges?: (() => void) | undefined;
}) {
  const { locale, t } = useTranslation();
  return (
    <AssetStatus
      published
      draft={
        draft === null
          ? undefined
          : {
              revision: draft.revision,
              author: draft.author.release
                ? t("build.headByRelease")
                : draftAuthorLabel(draft.author, t),
              time: formatMomentShort(draft.updatedAt, locale),
              live: draft.liveRevision
            }
      }
      more={
        publishRight === undefined ? undefined : (
          <p className="text-muted-foreground">
            {t("agentDraft.publishNeedsRight", { right: publishRight })}
          </p>
        )
      }
      onShowChanges={onShowChanges}
    />
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
      ) : answer?.kind === "changed" ? (
        <Banner key="draft" tone="info" data-agent-draft="changed">
          {t("agentDraft.changed")}
        </Banner>
      ) : null
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
  const shown = notices.filter((notice) => notice !== null);
  // The head's state names the draft, its author and the time; the disabled Publish points
  // here for the right it needs, which the state's popover says as well.
  const reason =
    draft !== null && publishRight !== undefined ? (
      <p id={publishReasonId} className="sr-only">
        {t("agentDraft.publishNeedsRight", { right: publishRight })}
      </p>
    ) : null;
  return (
    <>
      {reason}
      {shown.length === 0 ? null : <div className="mb-3 grid gap-2">{shown}</div>}
    </>
  );
}

/**
 * The fields whose live version stands in the field's own box, behind its "Draft | Live |
 * Changes" switch: texts. Any other field shows its live value in a box under it.
 */
const IN_PLACE_FIELDS: ReadonlySet<DraftAgentField> = new Set([
  "displayName",
  "description",
  "welcomeMessage",
  "welcomeSubtitle",
  "instructions",
  "additionalInstructions"
]);

/**
 * What the draft changes on the page: its fields against the live agent, and the live value to
 * show under each field that does not show it in place.
 */
export function draftFieldsView(
  live: AgentFormState,
  draft: AgentFormState | undefined,
  titles: DraftTitles
): {
  fields: DraftAgentField[];
  /** Whether the draft changes the field. */
  changes(field: DraftAgentField): boolean;
  value(field: DraftAgentField): ReactNode;
  /** The field with its live value close under it, or the field alone. */
  around(field: DraftAgentField, input: ReactNode): ReactNode;
} {
  const fields = draft === undefined ? [] : draftAgentFields(live, draft);
  const value = (field: DraftAgentField) =>
    draft === undefined || !fields.includes(field) || IN_PLACE_FIELDS.has(field) ? null : (
      <PublishedAgentValue field={field} live={live} draft={draft} titles={titles} />
    );
  return {
    fields,
    changes: (field) => fields.includes(field),
    value,
    // The live value belongs to its field: it sits closer to it than to the next field. A
    // field the draft changes is where "View changes" leads.
    around: (field, input) => {
      if (!fields.includes(field)) return input;
      const shown = value(field);
      return (
        <div className="grid gap-2" data-draft-group={field}>
          {input}
          {shown}
        </div>
      );
    }
  };
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
    // A text shows its live version in its own box.
    case "displayName":
    case "description":
    case "welcomeMessage":
    case "welcomeSubtitle":
    case "instructions":
    case "additionalInstructions":
      return null;
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
