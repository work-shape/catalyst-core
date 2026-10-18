import { Library } from "lucide-react";
import { Chip, Picker, PickerButton } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import type { KnowledgeChoice } from "./knowledge-base-source";
import type { MoreRead } from "./paged-items";

/** The Knowledge Bases an agent can be given, as far as the instance was asked for them. */
export interface KnowledgeBaseChoice {
  /** The Knowledge Bases that match what the reader typed, the pages read so far. */
  options: readonly KnowledgeChoice[];
  /** Present while more match: the chooser's last row reads the next page. */
  more?: MoreRead;
  /** The reader typed into the search: the instance is asked for the ones that match. */
  onSearch(text: string): void;
  /**
   * The agent belongs to a workspace: its own workspace's Knowledge Bases are offered beside the
   * instance's. Otherwise only the instance's are.
   */
  workspaceOwned: boolean;
}

/**
 * The Knowledge Bases an agent answers from: one chip per chosen one and the chooser. However
 * many are chosen, the agent gets one tool over them.
 */
export function AgentKnowledge({
  choice,
  value,
  editable,
  onChange
}: {
  choice: KnowledgeBaseChoice;
  value: readonly string[];
  editable: boolean;
  onChange(knowledgeBases: string[]): void;
}) {
  const { t } = useTranslation();
  const byName = new Map(choice.options.map((option) => [option.name, option]));
  return (
    <>
      {value.length === 0 ? (
        <p className="text-body text-muted-foreground">{t("knowledge.agentNone")}</p>
      ) : (
        <ul aria-label={t("knowledge.agentSection")} className="flex flex-wrap gap-2">
          {value.map((name) => (
            <li key={name}>
              <Chip
                leading={<Library aria-hidden="true" />}
                onRemove={
                  editable ? () => onChange(value.filter((entry) => entry !== name)) : undefined
                }
              >
                {byName.get(name)?.title || name}
              </Chip>
            </li>
          ))}
        </ul>
      )}
      {editable ? (
        <div>
          <Picker
            multiple
            search
            wrapDescriptions
            className="w-120"
            label={t("knowledge.agentChoose")}
            // Says what the list holds, so a Knowledge Base of another workspace is not mistaken
            // for an unpublished one. An unpublished one says so on its own row.
            note={t(
              choice.workspaceOwned ? "knowledge.agentNoteWorkspace" : "knowledge.agentNoteInstance"
            )}
            onSearchChange={choice.onSearch}
            more={choice.more && { loading: choice.more.loading, onLoad: choice.more.load }}
            options={choice.options.map((option) => ({
              value: option.name,
              label: option.title || option.name,
              description: option.unpublished
                ? [t("knowledge.agentUnpublished"), option.description].filter(Boolean).join(" · ")
                : option.description,
              keywords: option.name,
              leading: <Library aria-hidden="true" />
            }))}
            value={value}
            onValueChange={onChange}
          >
            <PickerButton
              label={t("knowledge.agentSection")}
              placeholder={t("knowledge.agentChoose")}
              value={undefined}
            />
          </Picker>
        </div>
      ) : null}
    </>
  );
}
