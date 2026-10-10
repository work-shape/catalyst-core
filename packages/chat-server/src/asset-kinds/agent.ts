import {
  agentConfigSchema,
  assertSpendBudgetPricingCoverage,
  findAgentReferenceIssues,
  resolveLocalizedString,
  type ClientInstanceConfig
} from "@vivd-catalyst/config-schema";
import {
  AGENT_EDITABLE_FIELDS,
  AGENT_MODEL_SETTING_FIELDS,
  AppError,
  defineAssetKind,
  findNamespaceOfAssetName,
  type AgentConfig,
  type AgentEditableField,
  type AgentModelSettingField,
  type Namespace
} from "@vivd-catalyst/core";
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
  const locale = options.config.localization.defaultLocale;
  return {
    ...defineAssetKind({
      kind: "agent",
      plural: "agents",
      schema: agentConfigSchema,
      // What the schema accepts today: any name that is not empty.
      nameRule: { pattern: /^[\s\S]+$/u, description: "Agent name must not be empty" },
      actions: { read: "agent.read", write: "agent.write", delete: "agent.delete" },
      validate: (context, agents) =>
        findAgentReferenceIssues({
          agents,
          skillNames: context
            .definitions("skill")
            .flatMap((skill) => readDefinitionName(skill) ?? []),
          refs: options.validationRefs
        }).map((message) => ({ message })),
      validateWrite(context, agents) {
        assertSpendBudgetPricingCoverage(options.config, [...agents]);
        return (
          options.validateAgents?.(
            [...agents],
            agents.filter((agent) => context.changes("agent", agent.name))
          ) ?? []
        ).map((message) => ({ message }));
      },
      summarize: (agent) => {
        const description = resolveLocalizedString(agent.description, locale, locale);
        return {
          name: agent.name,
          title: resolveLocalizedString(agent.displayName, locale, locale),
          ...(description === undefined ? {} : { description })
        };
      }
    }),
    bundle: {
      definitions: (bundle) => bundle.agents,
      withDefinitions: (bundle, agents) => ({ ...bundle, agents })
    },
    holdsInstanceDefault: true,
    hasWorkspaceAvailability: true,

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

    assertInteractiveUpsertAllowed({ access, name, current, next, namespaces }) {
      if (current === undefined && !policy().allowAgentCreation) {
        throw new AppError("FORBIDDEN", "Interactive agent creation is disabled");
      }
      const editableFields = new Set<AgentEditableField>(policy().editableAgentFields);
      const changedFields = AGENT_EDITABLE_FIELDS.filter(
        (field) =>
          !configValuesEqual(readDefinitionField(current, field), readDefinitionField(next, field))
      );
      // Model settings are governed by a permission, not by the editable-field policy. The one
      // exception is the binding of an agent in a Namespace that lists bindings: the list is the
      // operator's choice of models for that Namespace, so its writer picks among them.
      const bindingListed = hasModelBindingList(namespaces, name);
      const changedModelSettings = AGENT_MODEL_SETTING_FIELDS.filter(
        (field) =>
          !(field === "modelBindingId" && bindingListed) &&
          !configValuesEqual(
            agentModelSettingValue(current, field),
            agentModelSettingValue(next, field)
          )
      );
      if (changedModelSettings.length > 0 && !access.authorize("agent_models.manage").allowed) {
        throw new AppError(
          "FORBIDDEN",
          `Changing agent model settings (${changedModelSettings.join(", ")}) requires 'agent_models.manage' permission`
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

function isAgentModelSettingField(field: string): field is AgentModelSettingField {
  return AGENT_MODEL_SETTING_FIELDS.some((candidate) => candidate === field);
}

function hasModelBindingList(namespaces: readonly Namespace[], agentName: string): boolean {
  return findNamespaceOfAssetName(namespaces, agentName)?.allowedModelBindingIds !== undefined;
}
