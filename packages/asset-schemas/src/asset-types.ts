/**
 * The shape of an agent and of a skill as a file holds it. These are the public half of the
 * asset model: a working copy, the command line tool and the instance read the same types.
 */

export const localeCodes = ["en", "de"] as const;

export type LocaleCode = (typeof localeCodes)[number];

export type LocalizedStringConfig =
  | string
  | {
      en?: string;
      de?: string;
    };

export const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffortConfig = (typeof REASONING_EFFORTS)[number];

export interface AgentInitialPromptConfig {
  title: LocalizedStringConfig;
  prompt: LocalizedStringConfig;
}

export interface AgentConfig {
  name: string;
  displayName: LocalizedStringConfig;
  description?: LocalizedStringConfig;
  welcomeMessage?: LocalizedStringConfig;
  welcomeSubtitle?: LocalizedStringConfig;
  instructions: string;
  modelProviderId?: string;
  modelBindingId?: string;
  reasoningEffort?: ReasoningEffortConfig;
  fastMode?: boolean;
  /** Bindings users may pick for this agent in the chat, besides its own `modelBindingId`. */
  userSelectableModelBindingIds?: string[];
  /**
   * Reasoning effort per user-selectable binding. `reasoningEffort` stays the effort of the
   * agent's own model and is not applied to a model a user picked instead.
   */
  modelReasoningEfforts?: Record<string, ReasoningEffortConfig>;
  maxSteps?: number;
  toolNames: string[];
  skillNames: string[];
  initialPrompts: AgentInitialPromptConfig[];
}

export interface SkillConfig {
  name: string;
  title: string;
  /** For the agent: when to use the skill. */
  description: string;
  /**
   * For people: one sentence on one line that says what an agent with the skill knows how to
   * do. Lists and choosers show it under the title.
   */
  summary?: string;
  content: string;
  resources?: SkillResourceConfig[];
}

/** The most characters a skill's `summary` holds. */
export const SKILL_SUMMARY_MAX_LENGTH = 120;

/**
 * Who ships a skill, as a list says it. Every stored skill is the instance's own; `release`
 * is kept for the skills a module ships, which the release seed alone will write.
 */
export const SKILL_ORIGINS = ["instance", "release"] as const;

export type SkillOrigin = (typeof SKILL_ORIGINS)[number];

export const SKILL_RESOURCE_MEDIA_TYPES = [
  "text/markdown",
  "text/plain",
  "application/json",
  "application/yaml"
] as const;

export type SkillResourceMediaType = (typeof SKILL_RESOURCE_MEDIA_TYPES)[number];

export interface SkillResourceConfig {
  path: string;
  mediaType: SkillResourceMediaType;
  content: string;
}
