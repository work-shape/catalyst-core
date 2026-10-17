import { Check, X } from "lucide-react";
import { useId, type ReactNode } from "react";
import { Badge, Banner, Button, FoldedText, ProposedValue } from "@work-shape/catalyst-ui";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import {
  changedLanguages,
  listChange,
  proposedAgentFields,
  proposedSections,
  type ProposedAgentField
} from "./agent-proposal-model";
import type { AgentProposalState } from "./agent-proposal-source";
import { agentConfigToForm, type AgentFormState, type LocalizedPair } from "./asset-form-model";

/** The names people read for what an agent names by id, as far as the page knows them. */
export interface ProposalTitles {
  skill(name: string): string;
  tool(name: string): string;
  knowledgeBase(id: string): string;
  model(bindingId: string): string;
}

/**
 * What the page says of a pending proposal before its sections: that the agent in the chat
 * proposes the marked changes, with Apply and Discard for a reader who may change the agent,
 * or that the proposal no longer fits the agent and the agent in the chat must be asked again.
 */
export function AgentProposalNotice({
  state,
  name,
  changes,
  unsaved
}: {
  state: AgentProposalState;
  /** The title of the agent the proposal changes. */
  name: string;
  /** How many fields the proposal changes. */
  changes: number;
  /** The reader's own changes are not saved: an Apply would replace them. */
  unsaved: boolean;
}) {
  const { t } = useTranslation();
  const saveFirstId = useId();
  const { proposal, decide, busy, answer } = state;
  const stale = proposal.stale || answer?.kind === "stale";
  // Apply waits for the reader's own changes; the reason is a sentence, not only a tooltip.
  const blocked = decide !== undefined && !stale && unsaved;
  const actions =
    decide === undefined ? undefined : (
      <>
        {stale ? null : (
          <Button
            size="sm"
            data-proposal-apply=""
            loading={busy === "apply"}
            disabled={busy !== undefined || unsaved}
            aria-describedby={blocked ? saveFirstId : undefined}
            onClick={() => {
              decide.apply().catch(() => undefined);
            }}
          >
            <Check aria-hidden="true" />
            {t("agentProposal.apply")}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          data-proposal-discard=""
          loading={busy === "discard"}
          disabled={busy !== undefined}
          onClick={() => {
            decide.discard().catch(() => undefined);
          }}
        >
          <X aria-hidden="true" />
          {t("agentProposal.discard")}
        </Button>
      </>
    );
  return (
    <div className="mb-3 grid gap-2">
      <Banner
        tone={stale ? "warning" : "info"}
        data-agent-proposal={stale ? "stale" : "pending"}
        data-proposal-answer={!stale && answer?.kind === "changed" ? "changed" : undefined}
        action={actions}
      >
        {stale ? (
          t("agentProposal.stale")
        ) : (
          <div className="grid gap-1">
            {answer?.kind === "changed" ? <p>{t("agentProposal.changed")}</p> : null}
            <p>
              {t(
                PENDING_TEXT[decide === undefined ? "reader" : "writer"][
                  changes === 1 ? "one" : "many"
                ],
                { count: changes, name }
              )}
            </p>
            {blocked ? <p id={saveFirstId}>{t("agentProposal.saveFirst")}</p> : null}
          </div>
        )}
      </Banner>
      {answer === undefined || answer.kind === "stale" || answer.kind === "changed" ? null : (
        <Banner
          tone={answer.kind === "failed" ? "danger" : "warning"}
          data-proposal-answer={answer.kind}
        >
          {answer.kind === "failed" ? answer.message : t("configChangeWaitsForApproval")}
        </Banner>
      )}
    </div>
  );
}

// A reader who may not change the agent is told who can apply it, not to apply it.
const PENDING_TEXT: Record<"writer" | "reader", Record<"one" | "many", TranslationKey>> = {
  writer: { one: "agentProposal.pendingOne", many: "agentProposal.pending" },
  reader: { one: "agentProposal.pendingReaderOne", many: "agentProposal.pendingReader" }
};

/**
 * What a proposal changes on the page: its fields against the live agent, the sections that
 * hold them, and the proposed value to show under each. A stale proposal is no longer compared:
 * it was made against another agent than the page shows.
 */
export function proposedFieldsView(
  state: AgentProposalState | undefined,
  live: AgentFormState,
  titles: ProposalTitles
): {
  fields: ProposedAgentField[];
  sections: Set<string>;
  value(field: ProposedAgentField): ReactNode;
  /** The field with its proposed value close under it, or the field alone. */
  around(field: ProposedAgentField, input: ReactNode): ReactNode;
} {
  const proposed =
    state === undefined || state.proposal.stale || state.answer?.kind === "stale"
      ? undefined
      : agentConfigToForm(state.proposal.config);
  const fields = proposed === undefined ? [] : proposedAgentFields(live, proposed);
  const value = (field: ProposedAgentField) =>
    proposed === undefined || !fields.includes(field) ? null : (
      <ProposedAgentValue field={field} live={live} proposed={proposed} titles={titles} />
    );
  return {
    fields,
    sections: proposedSections(fields),
    value,
    // The proposed value belongs to its field: it sits closer to it than to the next field.
    around: (field, input) => {
      const shown = value(field);
      return shown === null ? (
        input
      ) : (
        <div className="grid gap-2" data-proposed-group={field}>
          {input}
          {shown}
        </div>
      );
    }
  };
}

/** The mark after the heading of a section that holds a proposed change. */
export function ProposedSectionMark() {
  const { t } = useTranslation();
  return (
    <Badge tone="accent" appearance="outline" data-proposed-section="">
      {t("agentProposal.sectionMark")}
    </Badge>
  );
}

/** The proposed value of one field, under the field that shows the live one. */
function ProposedAgentValue({
  field,
  live,
  proposed,
  titles
}: {
  field: ProposedAgentField;
  live: AgentFormState;
  proposed: AgentFormState;
  titles: ProposalTitles;
}) {
  const { t } = useTranslation();
  return (
    <ProposedValue label={t("agentProposal.label")} data-proposed-field={field}>
      <ProposedContent field={field} live={live} proposed={proposed} titles={titles} />
    </ProposedValue>
  );
}

function ProposedContent({
  field,
  live,
  proposed,
  titles
}: {
  field: ProposedAgentField;
  live: AgentFormState;
  proposed: AgentFormState;
  titles: ProposalTitles;
}): ReactNode {
  const { locale, t } = useTranslation();
  switch (field) {
    case "displayName":
    case "description":
    case "welcomeMessage":
    case "welcomeSubtitle":
      return <LanguageLines live={live[field]} proposed={proposed[field]} />;
    case "instructions":
      return <FoldedText>{proposed.instructions || t("agentProposal.empty")}</FoldedText>;
    case "maxSteps":
      return proposed.maxSteps || t("configInstanceDefault");
    case "model":
      return <ModelLines live={live} proposed={proposed} titles={titles} />;
    case "skillNames":
      return (
        <ListChange
          change={listChange(live.skillNames, proposed.skillNames)}
          title={titles.skill}
        />
      );
    case "knowledgeBases":
      return (
        <ListChange
          change={listChange(live.knowledgeBases, proposed.knowledgeBases)}
          title={titles.knowledgeBase}
        />
      );
    case "toolNames":
      return (
        <ListChange change={listChange(live.toolNames, proposed.toolNames)} title={titles.tool} />
      );
    case "initialPrompts": {
      // A starter is told by its title in the reader's language, and compared whole.
      const key = (prompt: AgentFormState["initialPrompts"][number]) => JSON.stringify(prompt);
      const titleOf = new Map(
        [...live.initialPrompts, ...proposed.initialPrompts].map((prompt) => [
          key(prompt),
          pairText(prompt.title, locale) || pairText(prompt.prompt, locale)
        ])
      );
      return (
        <ListChange
          change={listChange(live.initialPrompts.map(key), proposed.initialPrompts.map(key))}
          title={(entry) => titleOf.get(entry) ?? ""}
        />
      );
    }
  }
}

/** A text of the reader's language, or of the other one where it is empty there. */
function pairText(pair: LocalizedPair, locale: string): string {
  return (locale === "de" ? pair.de || pair.en : pair.en || pair.de).trim();
}

/** The languages whose text the proposal changes, each with its proposed text. */
function LanguageLines({ live, proposed }: { live: LocalizedPair; proposed: LocalizedPair }) {
  const { t } = useTranslation();
  return (
    <dl className="grid gap-1">
      {changedLanguages(live, proposed).map(({ language, text }) => (
        <div key={language} className="flex min-w-0 flex-wrap gap-x-2">
          <dt className="text-muted-foreground">
            {t(language === "en" ? "configEnglishLanguage" : "configGermanLanguage")}
          </dt>
          <dd className="min-w-0">{text || t("agentProposal.empty")}</dd>
        </div>
      ))}
    </dl>
  );
}

/** What a proposal adds to a list and takes from it. */
function ListChange({
  change,
  title
}: {
  change: { added: string[]; removed: string[] };
  title(name: string): string;
}) {
  const { t } = useTranslation();
  const line = (label: TranslationKey, names: string[]) =>
    names.length === 0 ? null : (
      <p>{t(label, { names: names.map((name) => title(name) || name).join(", ") })}</p>
    );
  return (
    <div className="grid gap-1">
      {line("agentProposal.adds", change.added)}
      {line("agentProposal.removes", change.removed)}
    </div>
  );
}

/** The model settings the proposal changes, one line each. */
function ModelLines({
  live,
  proposed,
  titles
}: {
  live: AgentFormState;
  proposed: AgentFormState;
  titles: ProposalTitles;
}) {
  const { t } = useTranslation();
  const lines: string[] = [];
  if (live.modelBindingId !== proposed.modelBindingId) {
    lines.push(
      `${t("build.defaultModel")}: ${
        proposed.modelBindingId ? titles.model(proposed.modelBindingId) : t("configInstanceDefault")
      }`
    );
  }
  if (live.reasoningEffort !== proposed.reasoningEffort) {
    lines.push(
      `${t("configReasoningEffort")}: ${proposed.reasoningEffort || t("configModelDefault")}`
    );
  }
  if (live.fastMode !== proposed.fastMode) {
    lines.push(
      `${t("configFastMode")}: ${t(proposed.fastMode ? "agentProposal.on" : "agentProposal.off")}`
    );
  }
  const selectable = listChange(
    live.userSelectableModelBindingIds,
    proposed.userSelectableModelBindingIds
  );
  for (const [label, names] of [
    ["agentProposal.adds", selectable.added],
    ["agentProposal.removes", selectable.removed]
  ] as const) {
    if (names.length > 0) {
      lines.push(
        `${t("build.selectableModels")}: ${t(label, { names: names.map(titles.model).join(", ") })}`
      );
    }
  }
  // The efforts of the models people may choose, and the provider, have no line of their own.
  if (lines.length === 0) lines.push(t("agentProposal.modelSettings"));
  return (
    <div className="grid gap-1">
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}
