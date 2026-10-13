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
  /** Up to `SKILL_STARTERS_MAX` first requests the empty chat offers for an agent with the skill. */
  starters?: SkillStarterConfig[];
  /**
   * The key of the interface's icon registry the skill shows beside its title, one of
   * `SKILL_ICON_KEYS`. A skill without one shows the generic skill icon.
   */
  icon?: SkillIconKey;
  content: string;
  resources?: SkillResourceConfig[];
}

/** How many starters one skill carries at most. */
export const SKILL_STARTERS_MAX = 2;
/** How many starters the empty chat shows for one agent at most. */
export const AGENT_STARTERS_MAX = 4;
/** The most characters a starter's `title` and its `hint` hold, in each language. */
export const SKILL_STARTER_LINE_MAX_LENGTH = 60;

/** One first request a skill offers on the empty chat. Choosing it fills the composer. */
export interface SkillStarterConfig {
  title: LocalizedStringConfig;
  /** One short line under the title. */
  hint?: LocalizedStringConfig;
  /** The text that fills the composer. */
  prompt: LocalizedStringConfig;
  /**
   * The tools the request needs. The starter shows only for an agent that holds every one of
   * them, so it never offers what the agent cannot do.
   */
  tools?: string[];
}

/** The most characters a skill's `summary` holds. */
export const SKILL_SUMMARY_MAX_LENGTH = 120;

/**
 * The icons a skill may name: the pages of the interface's icon registry. A skill's icon is a
 * page or the generic book, so no icon of a Connection or of a tool is among them.
 */
export const SKILL_ICON_KEYS = [
  "spreadsheet",
  "document",
  "presentation",
  "pdf",
  "image",
  "archive",
  "text",
  "file"
] as const;

export type SkillIconKey = (typeof SKILL_ICON_KEYS)[number];

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
