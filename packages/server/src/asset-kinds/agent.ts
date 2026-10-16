import {
  agentConfigSchema,
  assertSpendBudgetPricingCoverage,
  findAgentReferenceIssues,
  resolveLocalizedString,
  type ClientInstanceConfig
} from "@work-shape/catalyst-config-schema";
import {
  AGENT_EDITABLE_FIELDS,
  AGENT_MODEL_SETTING_FIELDS,
  AppError,
  ASSET_OWNER_KINDS,
  defineAssetKind,
  findNamespaceOfAssetName,
  KNOWLEDGE_BASE_ASSET_KIND,
  type AgentConfig,
  type AgentEditableField,
  type AgentModelSettingField,
  type AssetValidationContext,
  type AssetValidationIssue,
  type Namespace
} from "@work-shape/catalyst-core";
import {
  configValuesEqual,
  readDefinitionField,
  readDefinitionName,
  type ConfigAssetValidationRefs,
  type WorkflowAssetKind
} from "./shared";

export interface AgentAssetKindOptions {
  config: ClientInstanceConfig;
  validationRefs: ConfigAssetValidationRefs;
  /**
   * Checks only the assembly can make, such as what a model binding supports. `changed` are the
   * agents the write adds or changes; a rule that tolerates what is stored reads only them.
   */
  validateAgents?(agents: AgentConfig[], changed: AgentConfig[]): string[];
}

/** The agent kind: instructions with a model, tools and skills, usable where it is available. */
export function createAgentAssetKind(options: AgentAssetKindOptions): WorkflowAssetKind {
  const policy = () => options.config.administration.agentConfiguration;
  const defaultLocale = options.config.localization.defaultLocale;
  return {
    ...defineAssetKind({
      kind: "agent",
      plural: "agents",
      schema: agentConfigSchema,
      nameRule: {
        pattern: /^[\s\S]+$/u,
        description: "Agent name must not be empty",
        schema: agentConfigSchema.shape.name
      },
      actions: { read: "agent.read", write: "agent.write", delete: "agent.delete" },
      // The instance owns it, or the workspace it was made in (WS-OWN-1a).
      owners: [...ASSET_OWNER_KINDS],
      validate(context, agents) {
        const changed = agents.filter((agent) => context.changes("agent", agent.name));
        const skillNames = context
          .definitions("skill")
          .flatMap((skill) => readDefinitionName(skill) ?? []);
        return [
          ...findAgentReferenceIssues({
            agents: changed,
            skillNames,
            refs: options.validationRefs
          }).map((message) => ({ message })),
          // Deleting a skill an unchanged agent still lists remains a refused write.
          ...agents
            .filter((agent) => !context.changes("agent", agent.name))
            .flatMap((agent) =>
              agent.skillNames
                .filter((name) => context.changes("skill", name) && !skillNames.includes(name))
                .map((name) => ({
                  message: `Agent '${agent.name}' references missing skill '${name}'`
                }))
            ),
          ...missingKnowledgeBaseIssues(context, agents)
        ];
      },
      validateWrite(context, agents) {
        const changed = agents.filter((agent) => context.changes("agent", agent.name));
        assertSpendBudgetPricingCoverage(options.config, changed);
        return (options.validateAgents?.([...agents], changed) ?? []).map((message) => ({
          message
        }));
      },
      summarize: (agent, locale = defaultLocale) => {
        const description = resolveLocalizedString(agent.description, locale, defaultLocale);
        return {
          name: agent.name,
          title: resolveLocalizedString(agent.displayName, locale, defaultLocale),
          ...(description === undefined ? {} : { description })
        };
      }
    }),
    inRelease: true,
    holdsInstanceDefault: true,
    hasWorkspaceAvailability: true,
    references: (agent) => {
      const skillNames = readDefinitionField(agent, "skillNames");
      return Array.isArray(skillNames)
        ? skillNames.flatMap((name) => (typeof name === "string" ? [{ kind: "skill", name }] : []))
        : [];
    },

    // Switching to a binding without fast-mode support clears the flag instead of failing the save.
    prepareInteractiveUpsert({ current, next }) {
      const nextBindingId = next.modelBindingId;
      if (
        next.fastMode !== true ||
        nextBindingId === readDefinitionField(current, "modelBindingId") ||
        (typeof nextBindingId === "string" &&
          options.validationRefs.fastModeModelBindingIds.includes(nextBindingId))
      ) {
        return next;
      }
      const { fastMode: _fastMode, ...withoutFastMode } = next;
      return withoutFastMode;
    },

    missingUpsertRight({ access, name, current, next, namespaces }) {
      return changedModelSettings(namespaces, name, current, next).length > 0 &&
        !access.authorize(MODEL_SETTINGS_RIGHT).allowed
        ? MODEL_SETTINGS_RIGHT
        : undefined;
    },

    assertInteractiveUpsertAllowed({ access, name, current, next, namespaces }) {
      if (current === undefined && !policy().allowAgentCreation) {
        throw new AppError("FORBIDDEN", "Interactive agent creation is disabled");
      }
      const editableFields = new Set<AgentEditableField>(policy().editableAgentFields);
      const changedFields = AGENT_EDITABLE_FIELDS.filter(
        (field) =>
          !configValuesEqual(readDefinitionField(current, field), readDefinitionField(next, field))
      );
      const changedSettings = changedModelSettings(namespaces, name, current, next);
      if (changedSettings.length > 0 && !access.authorize(MODEL_SETTINGS_RIGHT).allowed) {
        throw new AppError(
          "FORBIDDEN",
          `Changing agent model settings (${changedSettings.join(", ")}) requires '${MODEL_SETTINGS_RIGHT}' permission`
        );
      }
      const protectedFields = changedFields.filter(
        (field) => !editableFields.has(field) && !isAgentModelSettingField(field)
      );
      if (protectedFields.length > 0) {
        throw new AppError(
          "FORBIDDEN",
          `Interactive changes are not allowed for agent field${protectedFields.length === 1 ? "" : "s"}: ${protectedFields.join(", ")}`
        );
      }
    },

    assertInteractiveDeleteAllowed() {
      if (!policy().allowAgentDeletion) {
        throw new AppError("FORBIDDEN", "Interactive agent deletion is disabled");
      }
    }
  };
}

/** A model setting of a stored or validated agent, with what an unset one means. */
export function agentModelSettingValue(agent: unknown, field: AgentModelSettingField): unknown {
  const value = readDefinitionField(agent, field);
  if (field === "fastMode") {
    return value ?? false;
  }
  if (field === "userSelectableModelBindingIds") {
    return value ?? [];
  }
  if (field === "modelReasoningEfforts") {
    return value ?? {};
  }
  return value;
}

/** The right that governs an agent's model settings. */
const MODEL_SETTINGS_RIGHT = "agent_models.manage";

/**
 * The model settings a save changes that the right governs. They are governed by a
 * permission, not by the editable-field policy. The one exception is the binding of an agent
 * in a Namespace that lists bindings: the list is the operator's choice of models for that
 * Namespace, so its writer picks among them.
 */
function changedModelSettings(
  namespaces: readonly Namespace[],
  name: string,
  current: unknown,
  next: unknown
): AgentModelSettingField[] {
  const bindingListed = hasModelBindingList(namespaces, name);
  return AGENT_MODEL_SETTING_FIELDS.filter(
    (field) =>
      !(field === "modelBindingId" && bindingListed) &&
      !configValuesEqual(
        agentModelSettingValue(current, field),
        agentModelSettingValue(next, field)
      )
  );
}

function isAgentModelSettingField(field: string): field is AgentModelSettingField {
  return AGENT_MODEL_SETTING_FIELDS.some((candidate) => candidate === field);
}

function hasModelBindingList(namespaces: readonly Namespace[], agentName: string): boolean {
  return findNamespaceOfAssetName(namespaces, agentName)?.allowedModelBindingIds !== undefined;
}

/**
 * A Knowledge Base an agent lists that the instance does not have. Only an agent the write
 * adds or changes is asked: a Knowledge Base deleted since stands in the way of no other write.
 * Where the module `knowledge` is off, the kind is not there and no Knowledge Base is.
 */
function missingKnowledgeBaseIssues(
  context: AssetValidationContext,
  agents: readonly AgentConfig[]
): AssetValidationIssue[] {
  const known = new Set(
    context
      .definitions(KNOWLEDGE_BASE_ASSET_KIND)
      .flatMap((knowledgeBase) => readDefinitionName(knowledgeBase) ?? [])
  );
  return agents
    .filter((agent) => context.changes("agent", agent.name))
    .flatMap((agent) =>
      (agent.knowledgeBases ?? []).flatMap((name, index) =>
        known.has(name)
          ? []
          : [
              {
                message: `Agent '${agent.name}' lists the Knowledge Base '${name}', which this instance does not have`,
                path: ["knowledgeBases", index],
                code: "knowledge_base_unknown"
              }
            ]
      )
    );
}
