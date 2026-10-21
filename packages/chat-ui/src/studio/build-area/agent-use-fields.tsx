import { useState } from "react";
import type { AgentUse } from "@work-shape/catalyst-api-client";
import { RadioGroup, TextLink } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { workspaceRoutePath } from "../../shared/routes";
import { FieldRefusals } from "./asset-form-fields";

/**
 * Who uses an agent where it is available (AGENT-USE-1): everyone who works there, or only the
 * people and roles given `agent.use` on it. Set beside "Available in" by whoever sets that.
 */
export interface AgentUseChoice {
  saved: AgentUse;
  /** Answers with what went wrong, if anything did. */
  save(use: AgentUse): Promise<string | undefined>;
}

/** The setting as the agent page edits it: the choice, whether it changed, and its save. */
export interface AgentUseEdit {
  use: AgentUse;
  setUse(use: AgentUse): void;
  changed: boolean;
  save(): Promise<string | undefined>;
  discard(): void;
}

export function useAgentUseEdit(choice: AgentUseChoice | undefined): AgentUseEdit {
  const saved = choice?.saved ?? "everyone";
  const [use, setUse] = useState<AgentUse>(saved);
  return {
    use,
    setUse,
    changed: choice !== undefined && use !== saved,
    save: async () => (choice === undefined ? undefined : choice.save(use)),
    discard: () => setUse(saved)
  };
}

/** The fields of the section "Who may use it". Rights themselves are given on Instance > Access. */
export function AgentUseFields({
  edit,
  disabled,
  refusals
}: {
  edit: AgentUseEdit;
  disabled: boolean;
  refusals: readonly string[];
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-3" data-agent-use="">
      <RadioGroup<AgentUse>
        variant="plain"
        label={t("configAgentUse")}
        labelHidden
        disabled={disabled}
        value={edit.use}
        onValueChange={edit.setUse}
        options={[
          {
            value: "everyone",
            label: t("configAgentUseEveryone"),
            description: t("configAgentUseEveryoneHint")
          },
          {
            value: "granted",
            label: t("configAgentUseGranted"),
            description: t("configAgentUseGrantedHint")
          }
        ]}
      />
      {edit.use === "granted" ? (
        <p className="text-caption">
          <TextLink
            href={workspaceRoutePath({ kind: "settings", group: "instance", page: "access" })}
          >
            {t("configAgentUseAccessLink")}
          </TextLink>
        </p>
      ) : null}
      <FieldRefusals messages={refusals} />
    </div>
  );
}
