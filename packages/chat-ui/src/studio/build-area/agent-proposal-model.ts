import { ASSET_LANGUAGES, type AgentFormState, type LocalizedPair } from "./asset-form-model";
import { readRefusalDetails } from "./build-refusals";
import { apiErrorCode } from "../../shared/workspace-utils";

// The pending change proposal of an agent on its page (TRY-1a2): what the agent of the dock's
// conversation saved for the agent, which a person applies or discards. The page compares the
// proposal with the live agent field by field, as the form holds them.

/** A field of the agent page that a proposal can change. */
export type ProposedAgentField =
  | "displayName"
  | "description"
  | "welcomeMessage"
  | "welcomeSubtitle"
  | "instructions"
  | "maxSteps"
  | "model"
  | "skillNames"
  | "knowledgeBases"
  | "toolNames"
  | "initialPrompts";

/** The parts of the form the Model section shows as one field. */
const MODEL_PARTS = [
  "modelProviderId",
  "modelBindingId",
  "reasoningEffort",
  "fastMode",
  "userSelectableModelBindingIds",
  "modelReasoningEfforts"
] as const satisfies readonly (keyof AgentFormState)[];

/** Each field in the order of the page, with the parts of the form it shows. */
const FIELD_PARTS: readonly (readonly [ProposedAgentField, readonly (keyof AgentFormState)[]])[] = [
  ["displayName", ["displayName"]],
  ["description", ["description"]],
  ["welcomeMessage", ["welcomeMessage"]],
  ["welcomeSubtitle", ["welcomeSubtitle"]],
  ["instructions", ["instructions"]],
  ["maxSteps", ["maxSteps"]],
  ["model", MODEL_PARTS],
  ["skillNames", ["skillNames"]],
  ["knowledgeBases", ["knowledgeBases"]],
  ["toolNames", ["toolNames"]],
  ["initialPrompts", ["initialPrompts"]]
];

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** The fields the proposal changes against the live agent, in the order of the page. */
export function proposedAgentFields(
  live: AgentFormState,
  proposed: AgentFormState
): ProposedAgentField[] {
  return FIELD_PARTS.filter(([, parts]) =>
    parts.some((part) => !same(live[part], proposed[part]))
  ).map(([field]) => field);
}

/** The section of the agent page each field stands in, by the section's anchor. */
const SECTION_OF_FIELD: Record<ProposedAgentField, string> = {
  displayName: "overview",
  description: "overview",
  welcomeMessage: "overview",
  welcomeSubtitle: "overview",
  instructions: "instructions",
  maxSteps: "instructions",
  model: "model",
  skillNames: "skills",
  knowledgeBases: "knowledge",
  toolNames: "tools",
  initialPrompts: "prompts"
};

/** The sections that hold a field the proposal changes. */
export function proposedSections(fields: readonly ProposedAgentField[]): Set<string> {
  return new Set(fields.map((field) => SECTION_OF_FIELD[field]));
}

/** What a proposal adds to a list of names and what it takes from it, each in its own order. */
export function listChange(
  live: readonly string[],
  proposed: readonly string[]
): { added: string[]; removed: string[] } {
  return {
    added: proposed.filter((name) => !live.includes(name)),
    removed: live.filter((name) => !proposed.includes(name))
  };
}

/** The languages of a text the proposal changes, each with its proposed text. */
export function changedLanguages(
  live: LocalizedPair,
  proposed: LocalizedPair
): { language: keyof LocalizedPair; text: string }[] {
  return ASSET_LANGUAGES.filter((language) => live[language] !== proposed[language]).map(
    (language) => ({ language, text: proposed[language] })
  );
}

/**
 * What a refused Apply means for the page: the agent wrote a newer proposal than the one the
 * person read (`changed`), or the agent was saved since the proposal was based on it (`stale`).
 * Anything else is told in the instance's words.
 */
export type AgentProposalRefusal = "changed" | "stale";

export function readProposalRefusal(error: unknown): AgentProposalRefusal | undefined {
  const code = apiErrorCode(error);
  const { reason } = readRefusalDetails(error);
  if (code === "REVISION_CONFLICT" && reason === "proposal_changed") return "changed";
  if (code === "CONFLICT" && reason === "stale_base") return "stale";
  return undefined;
}
