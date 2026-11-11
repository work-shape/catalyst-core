import { assetOfOperation } from "./operation-reference";
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
  operationDenialError,
  ownerOnlyOwnerOf,
  parseConnectionOperationName,
  KNOWLEDGE_BASE_ASSET_KIND,
  type AgentConfig,
  type AgentEditableField,
  type AgentModelSettingField,
  type AssetValidationContext,
  type AssetValidationIssue
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
  /**
   * The names of every agent the platform ships, also those of a module that is off: no write
   * but the release seed's creates an agent of one of them.
   */
  shippedAgentNames?: readonly string[];
}

/** The agent kind: instructions with a model, tools and skills, usable where it is available. */
export function createAgentAssetKind(options: AgentAssetKindOptions): WorkflowAssetKind {
  const policy = () => options.config.administration.agentConfiguration;
  const defaultLocale = options.config.localization.defaultLocale;
  const shippedNames = new Set(options.shippedAgentNames ?? []);
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
      actions: {
        read: "agent.read",
        write: "agent.write",
        publish: "agent.publish",
        // Decides the held publish of an agent a workspace owns (WS-PUB-1b).
        approve: "agent.approve",
        delete: "agent.delete"
      },
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
            agentNames: agents.map((agent) => agent.name),
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
        return [
          ...ownServerToolIssues(context, changed),
          ...(options.validateAgents?.([...agents], changed) ?? []).map((message) => ({
            message
          }))
        ];
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
      const tools = readDefinitionField(agent, "toolNames");
      return [
        ...[
          { field: "skillNames", kind: "skill" },
          { field: "knowledgeBases", kind: KNOWLEDGE_BASE_ASSET_KIND },
          { field: "subagentNames", kind: "agent" }
        ].flatMap(({ field, kind }) => {
          const names = readDefinitionField(agent, field);
          return Array.isArray(names)
            ? names.flatMap((name) => (typeof name === "string" ? [{ kind, name }] : []))
            : [];
        }),
        ...(Array.isArray(tools)
          ? tools.flatMap((name) =>
              typeof name === "string" ? (assetOfOperation(name) ?? []) : []
            )
          : [])
      ];
    },

    // What a shipped agent was shipped as is the release seed's alone: every write keeps it.
    // Which fields a release shipped anew is the seed's to add: a write may only take one out,
    // by taking the new version or keeping its own. A write that leaves the list out, such as
    // a config push, keeps it; one that empties it stores the empty list, so that publishing
    // the draft it saved does not bring the list back. The next release seed drops it.
    keepStored({ current, next }) {
      const shipped = readDefinitionField(current, "shipped");
      if (current === undefined && typeof next.name === "string" && shippedNames.has(next.name)) {
        throw new AppError(
          "FORBIDDEN",
          `The platform ships an agent named '${next.name}', also where its module is off: choose a name of your own`,
          { reason: "shipped_agent_name" }
        );
      }
      const { shipped: _sent, shippedNewer: sentNewer, ...rest } = next;
      if (shipped === undefined) return rest;
      const stored = readDefinitionField(current, "shippedNewer");
      if (!Array.isArray(stored)) return { ...rest, shipped };
      const newer = Array.isArray(sentNewer)
        ? sentNewer.filter((field) => stored.includes(field))
        : stored;
      return { ...rest, shipped, shippedNewer: newer };
    },

    assertStoredDeletable({ current }) {
      if (readDefinitionField(current, "shipped") === undefined) return;
      throw new AppError(
        "FORBIDDEN",
        `The agent '${readDefinitionName(current) ?? ""}' ships with the platform and cannot be deleted. To hide it, offer it in no workspace`,
        { reason: "shipped_agent" }
      );
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

    missingUpsertRight({ access, resource, current, next, modelBindingsListed }) {
      if (changedModelSettings(modelBindingsListed, current, next).length === 0) return undefined;
      // Asked with the agent: a personal key covers the right where it covers writing it.
      const decision = access.authorize(MODEL_SETTINGS_RIGHT, resource);
      return decision.allowed
        ? undefined
        : { action: MODEL_SETTINGS_RIGHT, reason: decision.reason };
    },

    assertInteractiveUpsertAllowed({ access, resource, current, next, modelBindingsListed }) {
      if (current === undefined && !policy().allowAgentCreation) {
        throw new AppError("FORBIDDEN", "Interactive agent creation is disabled");
      }
      const editableFields = new Set<AgentEditableField>(policy().editableAgentFields);
      // `next` is validated, with the definition's defaults filled in; `current` is as stored.
      const stored = withDefinitionDefaults(current);
      const changed = (field: string) =>
        !configValuesEqual(readDefinitionField(stored, field), readDefinitionField(next, field));
      // What the instance adds to the instructions is changed by who may change them.
      const changedFields = AGENT_EDITABLE_FIELDS.filter(
        (field) => changed(field) || (field === "instructions" && changed("additionalInstructions"))
      );
      const changedSettings = changedModelSettings(modelBindingsListed, current, next);
      const modelRight =
        changedSettings.length > 0 ? access.authorize(MODEL_SETTINGS_RIGHT, resource) : undefined;
      if (modelRight?.allowed === false) {
        throw modelRight.reason === "outside_key_scope"
          ? operationDenialError({
              kind: "forbidden",
              action: MODEL_SETTINGS_RIGHT,
              reason: modelRight.reason
            })
          : new AppError(
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

/**
 * A stored agent as its validated definition reads it: a field it leaves out holds the
 * definition's default, so that leaving it out and stating the default compare equal. A
 * definition the schema refuses stays as it is.
 */
function withDefinitionDefaults(agent: unknown): unknown {
  if (agent === undefined) return undefined;
  const parsed = agentConfigSchema.safeParse(agent);
  return parsed.success ? parsed.data : agent;
}

/** A model setting of a stored or validated agent, with what an unset one means. */
export function agentModelSettingValue(agent: unknown, field: AgentModelSettingField): unknown {
  const value = readDefinitionField(agent, field);
  if (field === "fastMode") {
    return value ?? false;
  }
  if (field === "useModelFallback") {
    return value ?? true;
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
 * a list of bindings binds, its workspace's: the list is the operator's choice
 * of models for it, so its writer picks among them.
 */
function changedModelSettings(
  modelBindingsListed: boolean,
  current: unknown,
  next: unknown
): AgentModelSettingField[] {
  return AGENT_MODEL_SETTING_FIELDS.filter(
    (field) =>
      !(field === "modelBindingId" && modelBindingsListed) &&
      !configValuesEqual(
        agentModelSettingValue(current, field),
        agentModelSettingValue(next, field)
      )
  );
}

function isAgentModelSettingField(field: string): field is AgentModelSettingField {
  return AGENT_MODEL_SETTING_FIELDS.some((candidate) => candidate === field);
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

/**
 * A tool of a server a person added for themselves on an agent the write adds or changes (PMCP-4):
 * such a server is on no agent, since an agent is offered to others. Its owner's own private
 * chats are offered its tools without one.
 */
function ownServerToolIssues(
  context: AssetValidationContext,
  agents: readonly AgentConfig[]
): AssetValidationIssue[] {
  const own = new Set(
    context
      .definitions("connection")
      .filter((connection) => ownerOnlyOwnerOf(connection) !== undefined)
      .flatMap((connection) => readDefinitionName(connection) ?? [])
  );
  if (own.size === 0) return [];
  return agents.flatMap((agent) =>
    agent.toolNames
      .filter((toolName) => {
        const connection = parseConnectionOperationName(toolName)?.connection;
        return connection !== undefined && own.has(connection);
      })
      .map((toolName) => ({
        message: `Agent '${agent.name}' lists '${toolName}', a tool of an MCP server a person added for themselves. Such a server is on no agent: its owner's own chats are offered its tools`,
        path: ["toolNames"],
        code: OWN_SERVER_TOOL_ON_AGENT
      }))
  );
}

/** The issue code of an agent that lists a tool of a person's own server. */
const OWN_SERVER_TOOL_ON_AGENT = "own_server_tool_on_agent";
