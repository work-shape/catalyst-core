import type { Asset } from "@vivd-catalyst/api-client";
import { Banner } from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import { useModuleName } from "../module-texts";
import type { AgentFormState } from "./asset-form-model";

/** What a stored agent names that this instance cannot run, as its read reports it. */
type AgentUnavailable = Pick<
  Asset,
  "unavailableTools" | "unavailableSkills" | "unavailableModels" | "chatAvailable"
>;

/** What a saved agent names, as far as its availability depends on it. */
type SavedAgentReferences = Pick<
  AgentFormState,
  | "toolNames"
  | "skillNames"
  | "modelProviderId"
  | "modelBindingId"
  | "userSelectableModelBindingIds"
>;

/**
 * What of the read's report still holds for the agent as last saved. The read is not repeated
 * after a save: a save that removed or replaced a reference repaired it, and a save cannot add
 * one, because the instance refuses a changed agent that names what it lacks.
 */
export function savedAgentUnavailable(
  status: AgentUnavailable | undefined,
  saved: SavedAgentReferences
): AgentUnavailable | undefined {
  if (status === undefined) return undefined;
  const unavailableModels = (status.unavailableModels ?? []).filter(({ name, field }) =>
    field === "userSelectableModelBindingIds"
      ? saved.userSelectableModelBindingIds.includes(name)
      : saved[field] === name
  );
  return {
    unavailableTools: (status.unavailableTools ?? []).filter(({ name }) =>
      saved.toolNames.includes(name)
    ),
    unavailableSkills: (status.unavailableSkills ?? []).filter(({ name }) =>
      saved.skillNames.includes(name)
    ),
    unavailableModels,
    ...(status.chatAvailable === undefined
      ? {}
      : {
          chatAvailable:
            status.chatAvailable ||
            !unavailableModels.some(({ field }) => field !== "userSelectableModelBindingIds")
        })
  };
}

/**
 * At the top of an agent's page: that the agent cannot chat while its model is missing, and one
 * line naming each tool, skill and model it names that this instance lacks, with the reason.
 */
export function AgentUnavailableNotices({ status }: { status: AgentUnavailable | undefined }) {
  const { t } = useTranslation();
  const moduleName = useModuleName();
  const items = [
    ...(status?.unavailableTools ?? []).map((tool) => ({
      key: `tool:${tool.name}`,
      name: tool.name,
      reason:
        tool.reason === "module_off"
          ? t("configUnavailableModuleOff", { module: moduleName(tool.module) })
          : t("configUnavailableUnknownTool")
    })),
    ...(status?.unavailableSkills ?? []).map((skill) => ({
      key: `skill:${skill.name}`,
      name: skill.name,
      reason: t("configUnavailableUnknownSkill")
    })),
    ...(status?.unavailableModels ?? []).map((model) => ({
      key: `model:${model.field}:${model.name}`,
      name: model.name,
      reason: t("configUnavailableUnknownModel")
    }))
  ];
  const chatUnavailable = status?.chatAvailable === false;
  if (!chatUnavailable && items.length === 0) {
    return null;
  }
  return (
    <div className="mb-3 grid gap-2">
      {chatUnavailable ? (
        <Banner tone="warning" title={t("configChatUnavailable")} data-agent-chat-unavailable="">
          {t("configChatUnavailableText")}
        </Banner>
      ) : null}
      {items.length > 0 ? (
        <Banner tone="warning" layout="line" data-agent-unavailable="">
          {t("configUnavailable")}:{" "}
          <ul aria-label={t("configUnavailable")} className="inline">
            {items.map((item, index) => (
              <li key={item.key} className="inline" data-unavailable-reference={item.key}>
                <span className="break-all text-foreground">{item.name}</span> ({item.reason})
                {index < items.length - 1 ? ", " : null}
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}
    </div>
  );
}
